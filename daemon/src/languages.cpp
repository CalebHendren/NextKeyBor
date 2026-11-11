#include "languages.h"

#include <algorithm>
#include <memory>
#include <set>
#include <vector>

#include "dbus_service.h"
#include "predict.h"
#include "util.h"

namespace nkb::languages {

namespace {

struct Lang {
    const char *code;    // hunspell dictionary name
    const char *name;
    const char *layout;  // xkb layout for org.gnome.desktop.input-sources
};

const Lang kLangs[] = {
    {"en_US", "English (US)", "us"},      {"en_GB", "English (UK)", "gb"},
    {"pl_PL", "Polish", "pl"},            {"de_DE", "German", "de"},
    {"fr_FR", "French", "fr"},            {"es_ES", "Spanish", "es"},
    {"it_IT", "Italian", "it"},           {"pt_PT", "Portuguese", "pt"},
    {"pt_BR", "Portuguese (Brazil)", "br"}, {"nl_NL", "Dutch", "nl"},
    {"sv_SE", "Swedish", "se"},           {"nb_NO", "Norwegian Bokmål", "no"},
    {"da_DK", "Danish", "dk"},            {"fi_FI", "Finnish", "fi"},
    {"cs_CZ", "Czech", "cz"},             {"sk_SK", "Slovak", "sk"},
    {"uk_UA", "Ukrainian", "ua"},         {"ru_RU", "Russian", "ru"},
    {"be_BY", "Belarusian", "by"},        {"lt_LT", "Lithuanian", "lt"},
    {"lv_LV", "Latvian", "lv"},           {"et_EE", "Estonian", "ee"},
    {"hu_HU", "Hungarian", "hu"},         {"ro_RO", "Romanian", "ro"},
    {"bg_BG", "Bulgarian", "bg"},         {"hr_HR", "Croatian", "hr"},
    {"sr_RS", "Serbian", "rs"},           {"sl_SI", "Slovenian", "si"},
    {"el_GR", "Greek", "gr"},             {"tr_TR", "Turkish", "tr"},
    {"ca_ES", "Catalan", "es+cat"},       {"eu_ES", "Basque", "es"},
    {"gl_ES", "Galician", "es"},          {"ga_IE", "Irish", "ie"},
    {"cy_GB", "Welsh", "gb"},             {"is_IS", "Icelandic", "is"},
    {"he_IL", "Hebrew", "il"},            {"ar", "Arabic", "ara"},
    {"fa_IR", "Persian", "ir"},           {"hi_IN", "Hindi", "in"},
    {"id_ID", "Indonesian", "us"},        {"ms_MY", "Malay", "us"},
    {"vi_VN", "Vietnamese", "vn"},        {"af_ZA", "Afrikaans", "za"},
    {"sw_KE", "Swahili", "ke"},           {"eo", "Esperanto", "epo"},
};

std::string lang_short(const std::string &code) {
    return code.substr(0, code.find('_'));
}

std::string dic_installed(const std::string &code) {
    for (const char *dir : {"/usr/share/hunspell", "/usr/share/myspell"}) {
        std::string p = join_path(dir, code + ".dic");
        if (file_exists(p))
            return p;
    }
    return "";
}

// ---- input sources ----

GSettings *input_sources() {
    static GSettings *s = [] {
        GSettingsSchemaSource *src = g_settings_schema_source_get_default();
        GSettingsSchema *schema = g_settings_schema_source_lookup(src, "org.gnome.desktop.input-sources", TRUE);
        if (!schema)
            return static_cast<GSettings *>(nullptr);
        g_settings_schema_unref(schema);
        return g_settings_new("org.gnome.desktop.input-sources");
    }();
    return s;
}

std::set<std::string> enabled_layouts() {
    std::set<std::string> out;
    if (!input_sources())
        return out;
    GVariant *v = g_settings_get_value(input_sources(), "sources");
    GVariantIter it;
    const gchar *type, *id;
    g_variant_iter_init(&it, v);
    while (g_variant_iter_next(&it, "(&s&s)", &type, &id))
        if (g_str_equal(type, "xkb"))
            out.insert(id);
    g_variant_unref(v);
    return out;
}

void enable_layout(const std::string &layout) {
    if (!input_sources() || layout.empty() || enabled_layouts().count(layout))
        return;
    GVariant *v = g_settings_get_value(input_sources(), "sources");
    GVariantBuilder b;
    g_variant_builder_init(&b, G_VARIANT_TYPE("a(ss)"));
    GVariantIter it;
    const gchar *type, *id;
    g_variant_iter_init(&it, v);
    while (g_variant_iter_next(&it, "(&s&s)", &type, &id))
        g_variant_builder_add(&b, "(ss)", type, id);
    g_variant_builder_add(&b, "(ss)", "xkb", layout.c_str());
    g_variant_unref(v);
    g_settings_set_value(input_sources(), "sources", g_variant_builder_end(&b));
}

// ---- PackageKit ----

// PK_FILTER_ENUM_NEWEST. NOT_INSTALLED is not usable: it still
// lists older available builds of packages that are installed.
constexpr guint64 kResolveFilter = 1ull << 16;
constexpr guint kInfoInstalled = 1;                 // PK_INFO_ENUM_INSTALLED
constexpr guint64 kFlagOnlyTrusted = 1ull << 1;     // PK_TRANSACTION_FLAG_ENUM_ONLY_TRUSTED
constexpr guint kExitSuccess = 1;                   // PK_EXIT_ENUM_SUCCESS

struct Install {
    std::string code, layout, what;
    std::vector<std::string> names;
    std::vector<std::string> package_ids;
    std::set<std::string> installed;  // package names already on the system
    std::string tx_path;
    guint sub_package = 0, sub_finished = 0, sub_error = 0, sub_props = 0;
    std::string error;
    bool resolving = true;
};

GDBusConnection *system_bus() {
    static GDBusConnection *c = g_bus_get_sync(G_BUS_TYPE_SYSTEM, nullptr, nullptr);
    return c;
}

void finish_install(std::shared_ptr<Install> in, bool ok, const std::string &msg) {
    if (ok) {
        enable_layout(in->layout);
        predict::reload(in->code);  // the dictionary is on disk now
    }
    Service::get().emit("DownloadFinished",
                        g_variant_new("(sbs)", in->what.c_str(), ok, msg.c_str()));
}

void unsubscribe(Install &in) {
    for (guint *id : {&in.sub_package, &in.sub_finished, &in.sub_error, &in.sub_props})
        if (*id) {
            g_dbus_connection_signal_unsubscribe(system_bus(), *id);
            *id = 0;
        }
}

void run_transaction(std::shared_ptr<Install> in);

void on_tx_signal(GDBusConnection *, const gchar *, const gchar *, const gchar *iface,
                  const gchar *signal, GVariant *params, gpointer ud) {
    auto in = *static_cast<std::shared_ptr<Install> *>(ud);
    if (g_str_equal(signal, "Package")) {
        guint info;
        const gchar *id, *summary;
        g_variant_get(params, "(u&s&s)", &info, &id, &summary);
        std::string pid = id, name = pid.substr(0, pid.find(';'));
        if (info == kInfoInstalled) {
            in->installed.insert(name);
            return;
        }
        bool dup = std::any_of(in->package_ids.begin(), in->package_ids.end(), [&](const std::string &p) {
            return p.substr(0, p.find(';')) == name;
        });
        if (!dup)
            in->package_ids.push_back(pid);
    } else if (g_str_equal(signal, "ErrorCode")) {
        guint code;
        const gchar *details;
        g_variant_get(params, "(u&s)", &code, &details);
        in->error = details;
    } else if (g_str_equal(signal, "PropertiesChanged") && g_str_equal(iface, "org.freedesktop.DBus.Properties")) {
        GVariant *changed = g_variant_get_child_value(params, 1);
        guint pct;
        if (g_variant_lookup(changed, "Percentage", "u", &pct) && pct <= 100 && !in->resolving)
            Service::get().emit("DownloadProgress", g_variant_new("(sd)", in->what.c_str(), pct / 100.0));
        g_variant_unref(changed);
    } else if (g_str_equal(signal, "Finished")) {
        guint exit_code, runtime;
        g_variant_get(params, "(uu)", &exit_code, &runtime);
        unsubscribe(*in);
        if (in->resolving) {
            in->resolving = false;
            std::erase_if(in->package_ids, [&](const std::string &p) {
                return in->installed.count(p.substr(0, p.find(';'))) > 0;
            });
            if (in->package_ids.empty()) {
                finish_install(in, true, "already installed");
                return;
            }
            run_transaction(in);
        } else {
            bool ok = exit_code == kExitSuccess;
            finish_install(in, ok, ok ? "installed" : (in->error.empty() ? "installation failed" : in->error));
        }
    }
}

void run_transaction(std::shared_ptr<Install> in) {
    g_dbus_connection_call(
        system_bus(), "org.freedesktop.PackageKit", "/org/freedesktop/PackageKit",
        "org.freedesktop.PackageKit", "CreateTransaction", nullptr, G_VARIANT_TYPE("(o)"),
        G_DBUS_CALL_FLAGS_NONE, -1, nullptr,
        [](GObject *src, GAsyncResult *res, gpointer ud) {
            auto holder = static_cast<std::shared_ptr<Install> *>(ud);
            auto in = *holder;
            delete holder;
            GError *err = nullptr;
            GVariant *r = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &err);
            if (!r) {
                finish_install(in, false, std::string("PackageKit unavailable: ") + err->message);
                g_error_free(err);
                return;
            }
            const gchar *path;
            g_variant_get(r, "(&o)", &path);
            in->tx_path = path;
            g_variant_unref(r);

            auto *sub_ud = new std::shared_ptr<Install>(in);
            auto free_ud = [](gpointer p) { delete static_cast<std::shared_ptr<Install> *>(p); };
            const char *tx_iface = "org.freedesktop.PackageKit.Transaction";
            // Only the Finished subscription owns the user data; the others borrow it.
            in->sub_finished = g_dbus_connection_signal_subscribe(
                system_bus(), "org.freedesktop.PackageKit", tx_iface, "Finished", path, nullptr,
                G_DBUS_SIGNAL_FLAGS_NONE, on_tx_signal, sub_ud, free_ud);
            in->sub_package = g_dbus_connection_signal_subscribe(
                system_bus(), "org.freedesktop.PackageKit", tx_iface, "Package", path, nullptr,
                G_DBUS_SIGNAL_FLAGS_NONE, on_tx_signal, sub_ud, nullptr);
            in->sub_error = g_dbus_connection_signal_subscribe(
                system_bus(), "org.freedesktop.PackageKit", tx_iface, "ErrorCode", path, nullptr,
                G_DBUS_SIGNAL_FLAGS_NONE, on_tx_signal, sub_ud, nullptr);
            in->sub_props = g_dbus_connection_signal_subscribe(
                system_bus(), "org.freedesktop.PackageKit", "org.freedesktop.DBus.Properties",
                "PropertiesChanged", path, nullptr, G_DBUS_SIGNAL_FLAGS_NONE, on_tx_signal, sub_ud, nullptr);

            GVariantBuilder b;
            g_variant_builder_init(&b, G_VARIANT_TYPE("as"));
            GVariant *call;
            if (in->resolving) {
                for (const auto &n : in->names)
                    g_variant_builder_add(&b, "s", n.c_str());
                call = g_variant_new("(tas)", kResolveFilter, &b);
            } else {
                for (const auto &p : in->package_ids)
                    g_variant_builder_add(&b, "s", p.c_str());
                call = g_variant_new("(tas)", kFlagOnlyTrusted, &b);
            }
            // Let polkit show its password dialog.
            g_dbus_connection_call(system_bus(), "org.freedesktop.PackageKit", path, tx_iface,
                                   in->resolving ? "Resolve" : "InstallPackages", call, nullptr,
                                   G_DBUS_CALL_FLAGS_ALLOW_INTERACTIVE_AUTHORIZATION, -1, nullptr,
                                   [](GObject *s, GAsyncResult *r2, gpointer ud2) {
                                       auto h = static_cast<std::shared_ptr<Install> *>(ud2);
                                       auto inst = *h;
                                       delete h;
                                       GError *e = nullptr;
                                       GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(s), r2, &e);
                                       if (v) {
                                           g_variant_unref(v);
                                           return;
                                       }
                                       unsubscribe(*inst);
                                       finish_install(inst, false, e->message);
                                       g_error_free(e);
                                   },
                                   new std::shared_ptr<Install>(in));
        },
        new std::shared_ptr<Install>(in));
}

void install(const std::string &code) {
    auto in = std::make_shared<Install>();
    in->code = code;
    in->what = "lang:" + code;
    for (const auto &l : kLangs)
        if (code == l.code)
            in->layout = l.layout;
    std::string s = lang_short(code);
    std::string dash = code;
    std::replace(dash.begin(), dash.end(), '_', '-');
    // Fedora names: hunspell-pl, langpacks-pl; some are region specific (hunspell-pt / langpacks-pt_BR).
    in->names = {"hunspell-" + s, "langpacks-" + s, "langpacks-" + code};
    Service::get().emit("DownloadProgress", g_variant_new("(sd)", in->what.c_str(), 0.0));
    run_transaction(in);
}

std::string list_json() {
    auto layouts = enabled_layouts();
    json out = json::array();
    std::set<std::string> seen;
    auto add = [&](const std::string &code, const std::string &name, const std::string &layout) {
        if (!seen.insert(code).second)
            return;
        out.push_back({{"code", code},
                       {"name", name},
                       {"dictionary", !dic_installed(code).empty()},
                       {"layout", layout},
                       {"layout_enabled", !layout.empty() && layouts.count(layout) > 0},
                       {"package", "hunspell-" + lang_short(code)},
                       {"active", code == predict::active_language()}});
    };
    for (const auto &l : kLangs)
        add(l.code, l.name, l.layout);
    // Any other installed dictionaries.
    for (const char *dir : {"/usr/share/hunspell", "/usr/share/myspell"}) {
        GDir *d = g_dir_open(dir, 0, nullptr);
        if (!d)
            continue;
        while (const gchar *f = g_dir_read_name(d)) {
            if (!g_str_has_suffix(f, ".dic"))
                continue;
            std::string code(f, strlen(f) - 4);
            if (code.find("hyph") == std::string::npos && code.find("th_") != 0)
                add(code, code, "");
        }
        g_dir_close(d);
    }
    // Installed first, then by name.
    std::stable_sort(out.begin(), out.end(), [](const json &a, const json &b) {
        return a["dictionary"].get<bool>() > b["dictionary"].get<bool>();
    });
    return out.dump();
}

}  // namespace

void init() {
    auto &svc = Service::get();
    svc.on("ListLanguages", [](GVariant *, GDBusMethodInvocation *inv) { reply_string(inv, list_json()); });
    svc.on("InstallLanguage", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *code;
        g_variant_get(params, "(&s)", &code);
        if (!valid_language_code(code)) {
            reply_error(inv, "invalid language code");
            return;
        }
        install(code);
        reply_empty(inv);
    });
    svc.on("SetActiveLanguage", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *code;
        g_variant_get(params, "(&s)", &code);
        predict::set_active_language(code);
        reply_empty(inv);
    });
}

}  // namespace nkb::languages
