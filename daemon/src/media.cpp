#include "media.h"

#include <algorithm>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <vector>

#include <glib/gstdio.h>
#include <utime.h>

#include "dbus_service.h"
#include "util.h"

namespace nkb::media {

namespace {

constexpr int kPageSize = 24;

// ---- helpers ----

std::string sha1(const std::string &s) {
    gchar *h = g_compute_checksum_for_string(G_CHECKSUM_SHA1, s.c_str(), -1);
    std::string out = h;
    g_free(h);
    return out;
}

std::string ext_of_url(const std::string &url) {
    std::string path = url.substr(0, url.find_first_of("?#"));
    size_t slash = path.rfind('/'), dot = path.rfind('.');
    if (dot == std::string::npos || (slash != std::string::npos && dot < slash))
        return ".gif";
    std::string ext = path.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
    if (ext.size() > 5)
        return ".gif";
    return ext;
}

std::string mime_of(const std::string &path) {
    std::string ext = ext_of_url(path);
    if (ext == ".webp")
        return "image/webp";
    if (ext == ".png")
        return "image/png";
    if (ext == ".jpg" || ext == ".jpeg")
        return "image/jpeg";
    if (ext == ".mp4")
        return "video/mp4";
    if (ext == ".webm")
        return "video/webm";
    return "image/gif";
}

std::string preview_cache_path(const std::string &url) {
    return join_path(cache_dir("media"), "p-" + sha1(url) + ext_of_url(url));
}

std::string full_cache_path(const std::string &url) {
    return join_path(cache_dir("media"), "f-" + sha1(url) + ext_of_url(url));
}

bool copy_file(const std::string &from, const std::string &to) {
    GFile *a = g_file_new_for_path(from.c_str()), *b = g_file_new_for_path(to.c_str());
    GError *err = nullptr;
    bool ok = g_file_copy(a, b, G_FILE_COPY_OVERWRITE, nullptr, nullptr, nullptr, &err);
    if (!ok) {
        g_warning("copy %s -> %s: %s", from.c_str(), to.c_str(), err->message);
        g_error_free(err);
    }
    g_object_unref(a);
    g_object_unref(b);
    return ok;
}

std::string client_id() {
    std::string path = join_path(data_dir(), "client-id"), id;
    if (read_file(path, id) && !trim(id).empty())
        return trim(id);
    id = random_id();
    write_file_atomic(path, id);
    return id;
}

bool text_matches(const std::string &query, const json &item) {
    auto toks = split_words(fold(query));
    if (toks.empty())
        return true;
    std::string hay = fold(item.value("title", "") + " " + item.value("tags", ""));
    return std::all_of(toks.begin(), toks.end(), [&](const std::string &t) { return hay.find(t) != std::string::npos; });
}

// A file directly in the favourites folder, which we may delete.
bool is_own_favorite_file(const std::string &path) {
    if (path.empty())
        return false;
    gchar *dir = g_path_get_dirname(path.c_str()), *base = g_path_get_basename(path.c_str());
    bool ours = data_dir("favorites") == dir && strcmp(base, ".") && strcmp(base, "..");
    g_free(dir);
    g_free(base);
    return ours;
}

// ---- local state (main thread only) ----

json g_favorites = json::array();   // items + {"file", "preview_file", "added"}
json g_library = json::array();     // own items + {"file", "added", "tags"}
std::set<std::string> g_fav_ids;
std::set<std::string> g_fav_fetching;            // favourite ids with a download running
int g_downloads_since_prune = 0;

std::string favorites_path() { return join_path(data_dir(), "favorites.json"); }
std::string library_path() { return join_path(data_dir(), "library.json"); }

void load_state() {
    g_favorites = load_json(favorites_path(), json::array());
    g_library = load_json(library_path(), json::array());
    if (!g_favorites.is_array())
        g_favorites = json::array();
    if (!g_library.is_array())
        g_library = json::array();
    g_fav_ids.clear();
    for (const auto &f : g_favorites)
        g_fav_ids.insert(f.value("id", ""));
}

void save_favorites() {
    save_json(favorites_path(), g_favorites);
    Service::get().emit("FavoritesChanged", g_variant_new("()"));
}

void save_library() {
    save_json(library_path(), g_library);
    Service::get().emit("OwnMediaChanged", g_variant_new("()"));
}

void prune_cache() {
    long long limit = static_cast<long long>(setting_int("gif-cache-mb", 300)) * 1024 * 1024;
    std::string dir = cache_dir("media");
    run_in_worker([dir, limit] {
        struct F { std::string path; long long size; gint64 mtime; };
        std::vector<F> files;
        long long total = 0;
        GDir *d = g_dir_open(dir.c_str(), 0, nullptr);
        if (!d)
            return;
        while (const gchar *n = g_dir_read_name(d)) {
            std::string p = join_path(dir, n);
            GStatBuf st;
            if (g_stat(p.c_str(), &st) == 0) {
                files.push_back({p, static_cast<long long>(st.st_size), static_cast<gint64>(st.st_mtime)});
                total += st.st_size;
            }
        }
        g_dir_close(d);
        std::sort(files.begin(), files.end(), [](const F &a, const F &b) { return a.mtime < b.mtime; });
        for (const auto &f : files) {
            if (total <= limit)
                break;
            g_unlink(f.path.c_str());
            total -= f.size;
        }
    });
}

void note_download() {
    if (++g_downloads_since_prune >= 40) {
        g_downloads_since_prune = 0;
        prune_cache();
    }
}

// Fills "preview" from the cache or schedules the thumbnail download.
void attach_preview(json &item) {
    item["favorite"] = g_fav_ids.count(item.value("id", "")) > 0;
    if (!item.value("preview", "").empty() && file_exists(item["preview"].get<std::string>()))
        return;
    std::string url = item.value("preview_url", "");
    item["preview"] = "";
    if (url.empty())
        return;
    std::string path = preview_cache_path(url);
    if (file_exists(path)) {
        item["preview"] = path;
        return;
    }
    std::string id = item.value("id", "");
    run_in_worker([url, path, id] {
        if (!file_exists(path) && !http_download(url, path).ok())
            return;
        run_on_main([id, path] {
            note_download();
            Service::get().emit("MediaPreviewReady", g_variant_new("(ss)", id.c_str(), path.c_str()));
        });
    });
}

// ---- providers (worker threads) ----

struct Query {
    std::string provider, kind, query, key, rating, client;
    unsigned offset;
};

std::string content_filter(const std::string &rating) {
    if (rating == "g")
        return "high";
    if (rating == "pg")
        return "medium";
    if (rating == "r")
        return "off";
    return "low";
}

json parse_giphy(const Query &q, const json &body) {
    json items = json::array();
    for (const auto &d : body.value("data", json::array())) {
        const json &img = d.value("images", json::object());
        auto url_of = [&](const char *k) { return img.contains(k) ? img[k].value("url", "") : std::string(); };
        std::string preview = url_of("fixed_height_small");
        if (preview.empty())
            preview = url_of("fixed_width_small");
        std::string full = url_of("downsized");
        if (full.empty())
            full = url_of("original");
        if (full.empty())
            continue;
        items.push_back({{"id", "giphy:" + d.value("id", "")}, {"source", "giphy"}, {"kind", q.kind},
                         {"title", d.value("title", "")}, {"preview_url", preview.empty() ? full : preview},
                         {"url", full}, {"preview", ""}});
    }
    return items;
}

json parse_klipy(const Query &q, const json &body) {
    json items = json::array();
    const json &outer = body.value("data", json::object());
    const json &list = outer.is_object() ? outer.value("data", json::array()) : outer;
    for (const auto &d : list) {
        if (!d.is_object())
            continue;
        const json &file = d.value("file", json::object());
        auto url_of = [&](const char *size, const char *fmt) {
            if (!file.contains(size) || !file[size].contains(fmt))
                return std::string();
            return file[size][fmt].value("url", "");
        };
        std::string preview = url_of("sm", "gif");
        if (preview.empty())
            preview = url_of("xs", "gif");
        std::string full = url_of("md", "gif");
        if (full.empty())
            full = url_of("hd", "gif");
        if (full.empty())
            continue;
        std::string id = d.contains("id") ? (d["id"].is_string() ? d["id"].get<std::string>() : d["id"].dump())
                                          : d.value("slug", "");
        items.push_back({{"id", "klipy:" + id}, {"source", "klipy"}, {"kind", q.kind},
                         {"title", d.value("title", "")}, {"preview_url", preview.empty() ? full : preview},
                         {"url", full}, {"preview", ""}});
    }
    return items;
}

// Openverse: openly licensed images, searchable without an account or key
// (anonymous limit: 20 requests a minute, 200 a day). Mostly Wikimedia
// animations rather than reaction GIFs.
constexpr int kOpenversePageSize = 20;

// Wikimedia Commons resizes animated GIFs, but only to its standard widths
// and never beyond the original.
std::string wikimedia_sized(const std::string &url, int original_width, int width) {
    const std::string prefix = "https://upload.wikimedia.org/wikipedia/commons/";
    if (url.compare(0, prefix.size(), prefix) != 0 || original_width <= width)
        return url;
    std::string name = url.substr(url.rfind('/') + 1);
    return prefix + "thumb/" + url.substr(prefix.size()) + "/" + std::to_string(width) + "px-" + name;
}

json parse_openverse(const Query &q, const json &body) {
    json items = json::array();
    // Callers page by item count, which need not be a multiple of our page
    // size: skip what they already have, and stop past the last page.
    unsigned page = q.offset / kOpenversePageSize + 1;
    if (page > body.value("page_count", 0u))
        return items;
    unsigned skip = q.offset % kOpenversePageSize;
    for (const auto &r : body.value("results", json::array())) {
        if (skip > 0) {
            skip--;
            continue;
        }
        std::string url = r.value("url", "");
        if (url.empty())
            continue;
        // Openverse's own thumbnail links fail (HTTP 424); nearly all GIFs
        // there come from Wikimedia, which serves smaller copies itself.
        int width = r.contains("width") && r["width"].is_number() ? r["width"].get<int>() : 0;
        items.push_back({{"id", "openverse:" + r.value("id", "")}, {"source", "openverse"}, {"kind", q.kind},
                         {"title", r.value("title", "")}, {"preview_url", wikimedia_sized(url, width, 120)},
                         {"url", wikimedia_sized(url, width, 330)}, {"preview", ""}});
    }
    return items;
}

json run_query(const Query &q, std::string &error) {
    std::string url;
    bool trending = trim(q.query).empty();
    std::string esc = url_escape(q.query);
    if (q.provider == "giphy") {
        url = "https://api.giphy.com/v1/" + std::string(q.kind == "sticker" ? "stickers" : "gifs") +
              (trending ? "/trending?" : "/search?q=" + esc + "&") + "api_key=" + url_escape(q.key) +
              "&limit=" + std::to_string(kPageSize) + "&offset=" + std::to_string(q.offset) +
              "&rating=" + q.rating + "&bundle=messaging_non_clips";
    } else if (q.provider == "openverse") {
        // No trending feed; show something lively for an empty query.
        std::string terms = trending ? "animated" : q.query;
        url = "https://api.openverse.org/v1/images/?q=" + url_escape(terms) + "&extension=gif" +
              "&page_size=" + std::to_string(kOpenversePageSize) +
              "&page=" + std::to_string(q.offset / kOpenversePageSize + 1) +
              "&mature=" + (q.rating == "r" ? "true" : "false");
    } else {
        url = "https://api.klipy.com/api/v1/" + url_escape(q.key) + "/" +
              (q.kind == "sticker" ? "stickers" : "gifs") + (trending ? "/trending?" : "/search?q=" + esc + "&") +
              "page=" + std::to_string(q.offset / kPageSize + 1) + "&per_page=" + std::to_string(kPageSize) +
              "&customer_id=" + url_escape(q.client) + "&content_filter=" + content_filter(q.rating);
    }
    auto r = http_get(url);
    if (!r.ok()) {
        error = q.provider + ": " + r.error;
        try {
            json b = json::parse(r.body);
            if (b.contains("meta") && b["meta"].contains("msg"))
                error += " (" + b["meta"]["msg"].get<std::string>() + ")";
            else if (b.contains("error") && b["error"].is_object())
                error += " (" + b["error"].value("message", "") + ")";
            else if (b.contains("errors") && b["errors"].is_object() && b["errors"].contains("message")) {
                const json &m = b["errors"]["message"];
                error += " (" + (m.is_array() && !m.empty() ? m[0].get<std::string>() : m.dump()) + ")";
            } else if (b.contains("detail") && b["detail"].is_string()) {
                error += " (" + b["detail"].get<std::string>() + ")";
            } else if (b.contains("message"))
                error += " (" + b["message"].get<std::string>() + ")";
        } catch (...) {
        }
        return json::array();
    }
    try {
        json body = json::parse(r.body);
        if (q.provider == "giphy")
            return parse_giphy(q, body);
        if (q.provider == "openverse")
            return parse_openverse(q, body);
        return parse_klipy(q, body);
    } catch (const std::exception &e) {
        error = q.provider + ": unexpected response (" + e.what() + ")";
        return json::array();
    }
}

}  // namespace

// The chosen provider, or Openverse (no key needed) until it has a key.
std::string effective_provider() {
    std::string provider = setting_string("gif-provider", "openverse");
    if (provider != "giphy" && provider != "klipy")
        return "openverse";
    if (setting_string((provider + "-api-key").c_str(), "").empty())
        return "openverse";
    return provider;
}

namespace {

std::string search(const std::string &kind_in, const std::string &query, unsigned offset) {
    std::string request_id = random_id();
    Query q;
    q.provider = effective_provider();
    q.kind = kind_in == "sticker" ? "sticker" : "gif";
    q.query = query;
    q.offset = offset;
    q.rating = setting_string("gif-content-rating", "pg-13");
    if (q.provider != "openverse")
        q.key = setting_string((q.provider + "-api-key").c_str(), "");
    q.client = client_id();
    if (q.key.empty() && q.provider != "openverse") {
        std::string msg = "No API key for " + q.provider + ". Add one in NextKeyBor settings (" + q.provider +
                          "-api-key).";
        run_on_main([request_id, msg] {
            Service::get().emit("MediaError", g_variant_new("(ss)", request_id.c_str(), msg.c_str()));
        });
        return request_id;
    }
    run_in_worker([q, request_id] {
        std::string error;
        json items = run_query(q, error);
        run_on_main([request_id, items, error]() mutable {
            if (!error.empty()) {
                Service::get().emit("MediaError", g_variant_new("(ss)", request_id.c_str(), error.c_str()));
                return;
            }
            for (auto &it : items)
                attach_preview(it);
            Service::get().emit("MediaResults", g_variant_new("(ss)", request_id.c_str(), items.dump().c_str()));
        });
    });
    return request_id;
}

// ---- favourites ----

json public_item(const json &stored) {
    json item = stored;
    std::string file = stored.value("file", "");
    std::string pf = stored.value("preview_file", "");
    item["preview"] = !pf.empty() && file_exists(pf) ? pf : (!file.empty() && file_exists(file) ? file : "");
    item["favorite"] = g_fav_ids.count(stored.value("id", "")) > 0;
    item.erase("preview_file");
    return item;
}

void set_favorite(json item, bool fav) {
    std::string id = item.value("id", "");
    if (id.empty())
        throw std::runtime_error("item has no id");
    if (!fav) {
        for (auto it = g_favorites.begin(); it != g_favorites.end(); ++it) {
            if (it->value("id", "") != id)
                continue;
            // Only delete our own copies, never a file from the user's library.
            for (const char *k : {"file", "preview_file"})
                if (std::string f = it->value(k, ""); is_own_favorite_file(f))
                    g_unlink(f.c_str());
            g_favorites.erase(it);
            break;
        }
        g_fav_ids.erase(id);
        save_favorites();
        return;
    }
    if (g_fav_ids.count(id))
        return;
    item["favorite"] = true;
    item["added"] = g_get_real_time() / 1000000;
    // The file paths are ours to fill in, never the caller's.
    item.erase("file");
    item.erase("preview_file");
    std::string source = item.value("source", "");
    if (source == "local") {
        for (const auto &l : g_library)
            if (l.value("id", "") == id)
                item["file"] = l.value("file", "");
        if (!item.contains("file"))
            throw std::runtime_error("unknown library item " + id);
    } else {
        std::string url = item.value("url", ""), purl = item.value("preview_url", "");
        std::string base = join_path(data_dir("favorites"), sha1(id));
        std::string file = base + ext_of_url(url), pfile = base + "-preview" + ext_of_url(purl);
        item["file"] = file;
        item["preview_file"] = purl.empty() ? "" : pfile;
        // Reuse what is cached, fetch the rest in the background.
        std::string fc = full_cache_path(url), pc = purl.empty() ? "" : preview_cache_path(purl);
        g_fav_fetching.insert(id);
        run_in_worker([id, url, purl, file, pfile, fc, pc] {
            if (file_exists(fc))
                copy_file(fc, file);
            else
                http_download(url, file);
            if (!purl.empty()) {
                if (file_exists(pc))
                    copy_file(pc, pfile);
                else
                    http_download(purl, pfile);
            }
            run_on_main([id] {
                g_fav_fetching.erase(id);
                Service::get().emit("FavoritesChanged", g_variant_new("()"));
            });
        });
    }
    item.erase("preview");
    g_favorites.insert(g_favorites.begin(), item);
    g_fav_ids.insert(id);
    save_favorites();
}

// Favourites are kept as local files so they work offline; fetch any copy
// whose download failed earlier (for example while offline).
void fetch_missing_favorites() {
    for (const auto &f : g_favorites) {
        std::string id = f.value("id", "");
        if (f.value("source", "") == "local" || g_fav_fetching.count(id))
            continue;
        std::vector<std::pair<std::string, std::string>> todo;  // url -> file
        for (auto [url_key, file_key] : {std::pair{"url", "file"}, std::pair{"preview_url", "preview_file"}}) {
            std::string url = f.value(url_key, ""), file = f.value(file_key, "");
            if (!url.empty() && !file.empty() && !file_exists(file))
                todo.emplace_back(url, file);
        }
        if (todo.empty())
            continue;
        g_fav_fetching.insert(id);
        run_in_worker([id, todo] {
            bool got = false;
            for (const auto &[url, file] : todo)
                got |= http_download(url, file).ok();
            run_on_main([id, got] {
                g_fav_fetching.erase(id);
                if (got)
                    Service::get().emit("FavoritesChanged", g_variant_new("()"));
            });
        });
    }
}

std::string list_favorites(const std::string &kind, const std::string &query) {
    fetch_missing_favorites();
    json out = json::array();
    for (const auto &f : g_favorites) {
        if (!kind.empty() && f.value("kind", "gif") != kind)
            continue;
        if (!text_matches(query, f))
            continue;
        out.push_back(public_item(f));
    }
    return out.dump();
}

// ---- own library ----

std::string list_own(const std::string &query) {
    json out = json::array();
    for (const auto &l : g_library) {
        if (!text_matches(query, l))
            continue;
        json item = l;
        item["preview"] = l.value("file", "");
        item["url"] = "file://" + l.value("file", "");
        item["preview_url"] = "";
        item["favorite"] = g_fav_ids.count(l.value("id", "")) > 0;
        out.push_back(item);
    }
    return out.dump();
}

void import_files(const std::vector<std::string> &paths, const std::string &tags) {
    bool changed = false;
    for (const auto &src : paths) {
        if (!file_exists(src)) {
            g_warning("import: %s does not exist", src.c_str());
            continue;
        }
        std::string ext = ext_of_url(src);
        std::string id = random_id();
        std::string dest = join_path(data_dir("library"), id + ext);
        if (!copy_file(src, dest))
            continue;
        gchar *base = g_path_get_basename(src.c_str());
        std::string title = base;
        g_free(base);
        size_t dot = title.rfind('.');
        if (dot != std::string::npos && dot > 0)
            title.resize(dot);
        std::replace(title.begin(), title.end(), '_', ' ');
        std::string mime = mime_of(dest);
        std::string kind = (mime == "image/png" || mime == "image/webp") ? "sticker" : "gif";
        g_library.insert(g_library.begin(), json{{"id", "local:" + id}, {"source", "local"}, {"kind", kind},
                                                 {"title", title}, {"tags", tags}, {"file", dest},
                                                 {"added", g_get_real_time() / 1000000}});
        changed = true;
    }
    if (changed)
        save_library();
}

void remove_own(const std::string &id) {
    for (auto it = g_library.begin(); it != g_library.end(); ++it) {
        if (it->value("id", "") != id)
            continue;
        g_unlink(it->value("file", "").c_str());
        g_library.erase(it);
        break;
    }
    if (g_fav_ids.count(id))
        set_favorite(json{{"id", id}}, false);
    save_library();
}

// xdg-desktop-portal file chooser; the reply arrives as a Response signal.
void open_portal_chooser(const std::string &tags) {
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
    if (!bus)
        return;
    std::string sender = g_dbus_connection_get_unique_name(bus) + 1;  // drop ':'
    std::replace(sender.begin(), sender.end(), '.', '_');
    std::string token = "nkb" + random_id();
    std::string handle = "/org/freedesktop/portal/desktop/request/" + sender + "/" + token;

    struct Ctx { std::string tags; guint sub = 0; GDBusConnection *bus; };
    auto *ctx = new Ctx{tags, 0, bus};
    ctx->sub = g_dbus_connection_signal_subscribe(
        bus, "org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response", handle.c_str(),
        nullptr, G_DBUS_SIGNAL_FLAGS_NO_MATCH_RULE,
        [](GDBusConnection *, const gchar *, const gchar *, const gchar *, const gchar *, GVariant *params,
           gpointer ud) {
            auto *c = static_cast<Ctx *>(ud);
            guint response;
            GVariant *results;
            g_variant_get(params, "(u@a{sv})", &response, &results);
            std::vector<std::string> paths;
            if (response == 0) {
                GVariant *uris = g_variant_lookup_value(results, "uris", G_VARIANT_TYPE("as"));
                if (uris) {
                    GVariantIter it;
                    const gchar *uri;
                    g_variant_iter_init(&it, uris);
                    while (g_variant_iter_next(&it, "&s", &uri)) {
                        gchar *p = g_filename_from_uri(uri, nullptr, nullptr);
                        if (p)
                            paths.emplace_back(p);
                        g_free(p);
                    }
                    g_variant_unref(uris);
                }
            }
            g_variant_unref(results);
            import_files(paths, c->tags);
            g_dbus_connection_signal_unsubscribe(c->bus, c->sub);
            g_object_unref(c->bus);
            delete c;
        },
        ctx, nullptr);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
    g_variant_builder_add(&opts, "{sv}", "multiple", g_variant_new_boolean(TRUE));
    g_variant_builder_add(&opts, "{sv}", "accept_label", g_variant_new_string("Add to NextKeyBor"));
    GVariantBuilder filters;
    g_variant_builder_init(&filters, G_VARIANT_TYPE("a(sa(us))"));
    GVariantBuilder pats;
    g_variant_builder_init(&pats, G_VARIANT_TYPE("a(us)"));
    for (const char *m : {"image/gif", "image/webp", "image/png", "image/jpeg", "video/mp4"})
        g_variant_builder_add(&pats, "(us)", 1u, m);
    g_variant_builder_add(&filters, "(sa(us))", "GIFs, stickers and videos", &pats);
    g_variant_builder_add(&opts, "{sv}", "filters", g_variant_builder_end(&filters));

    g_dbus_connection_call(bus, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                           "org.freedesktop.portal.FileChooser", "OpenFile",
                           g_variant_new("(ssa{sv})", "", "Add GIFs and stickers", &opts), G_VARIANT_TYPE("(o)"),
                           G_DBUS_CALL_FLAGS_NONE, -1, nullptr,
                           [](GObject *src, GAsyncResult *res, gpointer) {
                               GError *err = nullptr;
                               GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &err);
                               if (v) {
                                   g_variant_unref(v);
                               } else {
                                   g_warning("file chooser portal: %s", err->message);
                                   g_error_free(err);
                               }
                           },
                           nullptr);
}

// ---- PrepareMedia ----

std::pair<std::string, std::string> prepare(const json &item) {
    std::string id = item.value("id", "");
    for (const auto &f : g_favorites)
        if (f.value("id", "") == id) {
            std::string file = f.value("file", "");
            if (file_exists(file))
                return {file, mime_of(file)};
        }
    if (item.value("source", "") == "local") {
        for (const auto &l : g_library)
            if (l.value("id", "") == id)
                return {l.value("file", ""), mime_of(l.value("file", ""))};
        throw std::runtime_error("unknown library item " + id);
    }
    std::string url = item.value("url", "");
    if (url.empty())
        throw std::runtime_error("item has no url");
    std::string path = full_cache_path(url);
    if (file_exists(path)) {
        g_utime(path.c_str(), nullptr);  // keep recently used files in the cache
        return {path, mime_of(path)};
    }
    run_in_worker([id, url, path] {
        auto r = http_download(url, path);
        run_on_main([id, path, r] {
            if (!r.ok()) {
                Service::get().emit("MediaError", g_variant_new("(ss)", id.c_str(), r.error.c_str()));
                return;
            }
            note_download();
            Service::get().emit("MediaReady",
                                g_variant_new("(sss)", id.c_str(), path.c_str(), mime_of(path).c_str()));
        });
    });
    return {"", ""};
}

json parse_item(const gchar *s) {
    json j = json::parse(s);
    if (!j.is_object())
        throw std::runtime_error("item_json must be an object");
    return j;
}

}  // namespace

void init() {
    load_state();
    prune_cache();
    fetch_missing_favorites();
    auto &svc = Service::get();
    svc.on("SearchMedia", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *kind, *query;
        guint32 offset;
        g_variant_get(params, "(&s&su)", &kind, &query, &offset);
        reply_string(inv, search(kind, query, offset));
    });
    svc.on("ListFavorites", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *kind, *query;
        g_variant_get(params, "(&s&s)", &kind, &query);
        reply_string(inv, list_favorites(kind, query));
    });
    svc.on("ListOwnMedia", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *query;
        g_variant_get(params, "(&s)", &query);
        reply_string(inv, list_own(query));
    });
    svc.on("SetFavorite", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *item;
        gboolean fav;
        g_variant_get(params, "(&sb)", &item, &fav);
        set_favorite(parse_item(item), fav);
        reply_empty(inv);
    });
    svc.on("ImportOwnMedia", [](GVariant *params, GDBusMethodInvocation *inv) {
        GVariantIter *it;
        const gchar *tags, *p;
        g_variant_get(params, "(as&s)", &it, &tags);
        std::vector<std::string> paths;
        while (g_variant_iter_next(it, "&s", &p))
            paths.emplace_back(p);
        g_variant_iter_free(it);
        if (paths.empty())
            open_portal_chooser(tags);
        else
            import_files(paths, tags);
        reply_empty(inv);
    });
    svc.on("RemoveOwnMedia", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *id;
        g_variant_get(params, "(&s)", &id);
        remove_own(id);
        reply_empty(inv);
    });
    svc.on("PrepareMedia", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *item;
        g_variant_get(params, "(&s)", &item);
        auto [path, mime] = prepare(parse_item(item));
        g_dbus_method_invocation_return_value(inv, g_variant_new("(ss)", path.c_str(), mime.c_str()));
    });
}

}  // namespace nkb::media
