#include "keyboard_detect.h"

#include <algorithm>
#include <map>
#include <set>

#include <cerrno>

#include <fcntl.h>
#include <linux/input.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <glib-unix.h>

#include "dbus_service.h"

namespace nkb::keyboard {

namespace {

constexpr const char *kA11ySchema = "org.gnome.desktop.a11y.applications";
constexpr const char *kOskKey = "screen-keyboard-enabled";
// Type Cover exposes its keyboard even when folded behind the screen; the
// tablet-mode switch says it cannot be typed on then.
constexpr unsigned short kBuiltinCoverVendor = 0x045e;
constexpr int kRescanDelaysMs[] = {300, 1500, 4000};  // udev applies permissions after the node appears
constexpr double kTypingDebounceS = 5;

template <size_t N>
bool test_bit(const unsigned long (&bits)[N], unsigned bit) {
    constexpr unsigned per = sizeof(unsigned long) * 8;
    return bit / per < N && (bits[bit / per] >> (bit % per)) & 1UL;
}

struct Device {
    std::string path, name;
    int fd = -1;
    guint watch = 0;
    bool keyboard = false, tablet_switch = false;
    unsigned short bustype = 0, vendor = 0;
};

class Detector {
public:
    explicit Detector(bool manage) : manage_(manage) {
        GSettingsSchemaSource *src = g_settings_schema_source_get_default();
        if (GSettingsSchema *schema = g_settings_schema_source_lookup(src, kA11ySchema, TRUE)) {
            g_settings_schema_unref(schema);
            a11y_ = g_settings_new(kA11ySchema);
        }
    }

    void start();
    void rescan_blocking() { rescan(); }
    json state() const;
    bool desired_osk() const { return usable_keyboards().empty(); }

private:
    bool rescan();
    bool add(const std::string &path);
    bool drop(const std::string &path);
    std::vector<const Device *> usable_keyboards() const;
    void apply(bool osk_on, const std::string &reason, const std::string &detail = "", bool notify_always = false);
    void notify(bool osk_on, const std::string &reason, const std::string &detail);
    void schedule_rescan(int delay);
    void forget_unopened();
    void emit_state();
    void on_typing(const Device &dev);
    static gboolean on_input(gint fd, GIOCondition cond, gpointer self);
    bool osk_enabled() const { return a11y_ && g_settings_get_boolean(a11y_, kOskKey); }

    bool manage_;
    GSettings *a11y_ = nullptr;
    GFileMonitor *monitor_ = nullptr;
    std::map<std::string, Device> devices_;   // includes non-keyboards (fd -1) so we do not reopen
    bool tablet_mode_ = false;
    guint32 notification_id_ = 0;
    double last_typing_off_ = 0;
    std::set<int> pending_rescans_;
    std::string last_state_;
    int denied_ = 0;  // nodes we may not open (user not in the "input" group)
};

bool is_ignored(const std::string &name) {
    std::string lower = fold(name);
    for (const auto &part : setting_strv("ignored-keyboards", {"keyd virtual", "ydotool", "virtual keyboard", "uinput"}))
        if (!part.empty() && lower.find(fold(part)) != std::string::npos)
            return true;
    return false;
}

bool Detector::add(const std::string &path) {
    int fd = open(path.c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        if (errno == EACCES || errno == EPERM)
            denied_++;
        return false;  // not readable yet, or not ours; a delayed rescan retries
    }

    Device d;
    d.path = path;
    char name[256] = {};
    ioctl(fd, EVIOCGNAME(sizeof name - 1), name);
    d.name = name;
    input_id id{};
    ioctl(fd, EVIOCGID, &id);
    d.bustype = id.bustype;
    d.vendor = id.vendor;

    unsigned long keys[KEY_MAX / (sizeof(unsigned long) * 8) + 1] = {};
    unsigned long sws[SW_MAX / (sizeof(unsigned long) * 8) + 1] = {};
    ioctl(fd, EVIOCGBIT(EV_KEY, sizeof keys), keys);
    ioctl(fd, EVIOCGBIT(EV_SW, sizeof sws), sws);

    d.keyboard = test_bit(keys, KEY_A) && test_bit(keys, KEY_Z) && test_bit(keys, KEY_SPACE) &&
                 test_bit(keys, KEY_ENTER) && d.bustype != BUS_VIRTUAL && !is_ignored(d.name);
    d.tablet_switch = test_bit(sws, SW_TABLET_MODE);

    if (!d.keyboard && !d.tablet_switch) {
        close(fd);
        devices_[path] = d;  // remember so we do not reopen it
        return false;
    }
    d.fd = fd;
    if (d.tablet_switch) {
        unsigned long state[SW_MAX / (sizeof(unsigned long) * 8) + 1] = {};
        if (ioctl(fd, EVIOCGSW(sizeof state), state) >= 0)
            tablet_mode_ = test_bit(state, SW_TABLET_MODE);
        g_message("tablet switch: %s, tablet_mode=%d", d.name.c_str(), tablet_mode_);
    }
    if (d.keyboard)
        g_message("keyboard connected: %s (%s)", d.name.c_str(), path.c_str());
    if (monitor_)  // only watch events when running as a daemon
        d.watch = g_unix_fd_add(fd, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR), on_input, this);
    devices_[path] = d;
    return true;
}

bool Detector::drop(const std::string &path) {
    auto it = devices_.find(path);
    if (it == devices_.end())
        return false;
    Device d = it->second;
    devices_.erase(it);
    if (d.watch)
        g_source_remove(d.watch);
    if (d.fd >= 0)
        close(d.fd);
    if (d.keyboard && d.fd >= 0)
        g_message("keyboard disconnected: %s (%s)", d.name.c_str(), path.c_str());
    return d.keyboard && d.fd >= 0;
}

bool Detector::rescan() {
    denied_ = 0;
    std::set<std::string> present;
    if (GDir *dir = g_dir_open("/dev/input", 0, nullptr)) {
        while (const gchar *n = g_dir_read_name(dir))
            if (g_str_has_prefix(n, "event"))
                present.insert(join_path("/dev/input", n));
        g_dir_close(dir);
    }
    bool changed = false;
    std::vector<std::string> gone;
    for (auto &[path, d] : devices_)
        if (!present.count(path))
            gone.push_back(path);
    for (const auto &p : gone)
        changed |= drop(p);
    for (const auto &p : present)
        if (!devices_.count(p))
            changed |= add(p);
    return changed;
}

void Detector::forget_unopened() {
    // Retry nodes that were unreadable or unknown when they first appeared.
    for (auto it = devices_.begin(); it != devices_.end();)
        it = it->second.fd < 0 ? devices_.erase(it) : std::next(it);
}

void Detector::schedule_rescan(int delay) {
    if (!pending_rescans_.insert(delay).second)
        return;
    struct Ctx { Detector *self; int delay; };
    g_timeout_add_full(G_PRIORITY_DEFAULT, static_cast<guint>(delay), [](gpointer p) -> gboolean {
        auto *c = static_cast<Ctx *>(p);
        c->self->pending_rescans_.erase(c->delay);
        c->self->forget_unopened();
        if (c->self->rescan())
            c->self->apply(c->self->desired_osk(), "devices");
        c->self->emit_state();
        return G_SOURCE_REMOVE;
    }, new Ctx{this, delay}, [](gpointer p) { delete static_cast<Ctx *>(p); });
}

gboolean Detector::on_input(gint fd, GIOCondition cond, gpointer p) {
    auto *self = static_cast<Detector *>(p);
    auto it = std::find_if(self->devices_.begin(), self->devices_.end(),
                           [fd](const auto &kv) { return kv.second.fd == fd; });
    if (it == self->devices_.end())
        return G_SOURCE_REMOVE;
    std::string path = it->first;
    auto gone = [&] {
        self->devices_[path].watch = 0;  // this source is being removed by returning
        if (self->drop(path))
            self->apply(self->desired_osk(), "devices");
        self->emit_state();
        return G_SOURCE_REMOVE;
    };
    if (cond & (G_IO_HUP | G_IO_ERR))
        return gone();

    input_event evs[64];
    for (;;) {
        ssize_t n = read(fd, evs, sizeof evs);
        if (n < 0)
            return errno == EAGAIN ? G_SOURCE_CONTINUE : gone();
        if (n == 0)
            return gone();
        for (size_t i = 0; i < static_cast<size_t>(n) / sizeof(input_event); i++) {
            const input_event &ev = evs[i];
            if (ev.type == EV_SW && ev.code == SW_TABLET_MODE) {
                self->tablet_mode_ = ev.value != 0;
                g_message("tablet_mode=%d", self->tablet_mode_);
                self->apply(self->desired_osk(), "tablet");
                self->emit_state();
            } else if (ev.type == EV_KEY && ev.value == 1 &&
                       ((ev.code >= KEY_1 && ev.code <= KEY_SLASH) || ev.code == KEY_SPACE)) {
                auto d = self->devices_.find(path);
                if (d != self->devices_.end() && d->second.keyboard)
                    self->on_typing(d->second);
            }
        }
    }
}

void Detector::on_typing(const Device &dev) {
    if (!setting_bool("hide-osk-on-typing", true) || !osk_enabled())
        return;
    double now = static_cast<double>(g_get_monotonic_time()) / 1e6;
    if (now - last_typing_off_ < kTypingDebounceS)
        return;
    last_typing_off_ = now;
    apply(false, "typing", dev.name);
}

std::vector<const Device *> Detector::usable_keyboards() const {
    std::vector<const Device *> out;
    for (const auto &[path, d] : devices_) {
        if (!d.keyboard || d.fd < 0)
            continue;
        bool builtin_cover = d.vendor == kBuiltinCoverVendor && d.bustype != BUS_BLUETOOTH;
        if (tablet_mode_ && builtin_cover)
            continue;
        out.push_back(&d);
    }
    return out;
}

void Detector::apply(bool osk_on, const std::string &reason, const std::string &detail, bool notify_always) {
    if (!manage_ || !a11y_ || !setting_bool("auto-toggle-osk", true))
        return;
    // A keyboard may be among the devices we cannot read; never turn the OSK
    // on from a guess (it would then open on the lock screen and in dialogs).
    if (osk_on && denied_ && usable_keyboards().empty()) {
        g_message("not enabling the OSK (%s): %d input devices unreadable", reason.c_str(), denied_);
        return;
    }
    bool current = osk_enabled();
    if (current != osk_on) {
        g_settings_set_boolean(a11y_, kOskKey, osk_on);
        g_settings_sync();
    } else if (!notify_always) {
        return;
    }
    g_message("osk=%d reason=%s", osk_on, reason.c_str());
    notify(osk_on, reason, detail);
}

void Detector::notify(bool osk_on, const std::string &reason, const std::string &detail) {
    if (!setting_bool("notify-keyboard-changes", true))
        return;
    std::string names;
    for (const auto *d : usable_keyboards())
        names += (names.empty() ? "" : ", ") + d->name;
    std::string body;
    if (reason == "typing")
        body = "Typing detected on " + detail + ".";
    else if (reason == "tablet" && osk_on)
        body = "Type Cover folded back (tablet mode).";
    else if (osk_on)
        body = "No physical keyboard available.";
    else
        body = "Physical keyboard: " + names + ".";
    const char *summary = osk_on ? "On-screen keyboard enabled" : "On-screen keyboard disabled";

    GVariantBuilder hints;
    g_variant_builder_init(&hints, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&hints, "{sv}", "transient", g_variant_new_boolean(TRUE));
    g_variant_builder_add(&hints, "{sv}", "category", g_variant_new_string("device"));
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
    if (!bus)
        return;
    g_dbus_connection_call(
        bus, "org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications",
        "Notify",
        g_variant_new("(susssasa{sv}i)", "Keyboard", notification_id_, "input-keyboard-symbolic", summary,
                      body.c_str(), nullptr, &hints, 4000),
        G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 2000, nullptr,
        [](GObject *src, GAsyncResult *res, gpointer self) {
            GError *err = nullptr;
            GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &err);
            if (!v) {
                g_warning("notification failed: %s", err->message);
                g_error_free(err);
                return;
            }
            g_variant_get(v, "(u)", &static_cast<Detector *>(self)->notification_id_);
            g_variant_unref(v);
        },
        this);
    g_object_unref(bus);
}

json Detector::state() const {
    json names = json::array();
    for (const auto *d : usable_keyboards())
        names.push_back(d->name);
    json all = json::array();
    for (const auto &[path, d] : devices_)
        if (d.keyboard && d.fd >= 0)
            all.push_back({{"name", d.name}, {"path", path}, {"vendor", d.vendor}, {"bus", d.bustype}});
    return {{"physical", names},
            {"devices", all},
            {"tablet_mode", tablet_mode_},
            {"unreadable_devices", denied_},
            {"osk_enabled", osk_enabled()},
            {"auto_toggle", setting_bool("auto-toggle-osk", true) && manage_}};
}

void Detector::emit_state() {
    std::string s = state().dump();
    if (s == last_state_)
        return;
    last_state_ = s;
    Service::get().emit("KeyboardStateChanged", g_variant_new("(s)", s.c_str()));
}

void Detector::start() {
    if (a11y_) {
        g_signal_connect(a11y_, "changed::screen-keyboard-enabled",
                         G_CALLBACK(+[](GSettings *, gchar *, gpointer self) {
                             static_cast<Detector *>(self)->emit_state();
                         }),
                         this);
    }
    if (settings())
        g_signal_connect(settings(), "changed::auto-toggle-osk", G_CALLBACK(+[](GSettings *, gchar *, gpointer self) {
                             auto *d = static_cast<Detector *>(self);
                             d->apply(d->desired_osk(), "settings");
                             d->emit_state();
                         }),
                         this);

    GFile *dir = g_file_new_for_path("/dev/input");
    monitor_ = g_file_monitor_directory(dir, G_FILE_MONITOR_NONE, nullptr, nullptr);
    g_object_unref(dir);
    if (monitor_)
        g_signal_connect(monitor_, "changed",
                         G_CALLBACK(+[](GFileMonitor *, GFile *file, GFile *, GFileMonitorEvent event, gpointer p) {
                             auto *self = static_cast<Detector *>(p);
                             gchar *base = g_file_get_basename(file);
                             bool is_event = g_str_has_prefix(base, "event");
                             g_free(base);
                             if (!is_event)
                                 return;
                             if (event == G_FILE_MONITOR_EVENT_CREATED || event == G_FILE_MONITOR_EVENT_DELETED ||
                                 event == G_FILE_MONITOR_EVENT_ATTRIBUTE_CHANGED) {
                                 if (event == G_FILE_MONITOR_EVENT_CREATED) {
                                     gchar *path = g_file_get_path(file);
                                     auto it = self->devices_.find(path);
                                     if (it != self->devices_.end() && it->second.fd < 0)
                                         self->devices_.erase(it);
                                     g_free(path);
                                 }
                                 for (int delay : kRescanDelaysMs)
                                     self->schedule_rescan(delay);
                             }
                         }),
                         this);

    rescan();
    apply(desired_osk(), "startup", "", true);
    g_timeout_add_seconds(60, [](gpointer p) -> gboolean {
        auto *self = static_cast<Detector *>(p);
        if (self->rescan())
            self->apply(self->desired_osk(), "devices");
        self->emit_state();
        return G_SOURCE_CONTINUE;
    }, this);
    emit_state();
}

Detector *g_detector = nullptr;

}  // namespace

void init(bool manage) {
    g_detector = new Detector(manage);
    g_detector->start();
    Service::get().on("GetKeyboardState", [](GVariant *, GDBusMethodInvocation *inv) {
        reply_string(inv, g_detector->state().dump());
    });
}

json state() {
    return g_detector ? g_detector->state() : json::object();
}

json scan_once() {
    Detector d(false);
    d.rescan_blocking();
    json s = d.state();
    s["osk_should_be_enabled"] = d.desired_osk();
    return s;
}

}  // namespace nkb::keyboard
