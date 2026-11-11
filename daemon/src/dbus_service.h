// Owns the io.github.nextkeybor.Daemon bus name and dispatches method calls.
#pragma once

#include <functional>
#include <map>
#include <string>

#include <gio/gio.h>

namespace nkb {

constexpr const char *kBusName = "io.github.nextkeybor.Daemon";
constexpr const char *kObjectPath = "/io/github/nextkeybor/Daemon";
constexpr const char *kInterface = "io.github.nextkeybor.Daemon";

class Service {
public:
    // Handlers must reply to the invocation exactly once (possibly later).
    using Handler = std::function<void(GVariant *params, GDBusMethodInvocation *inv)>;

    static Service &get();

    void on(const std::string &method, Handler h) { handlers_[method] = std::move(h); }
    // Takes ownership of a floating params variant. Safe from the main thread only.
    // With a destination (a unique bus name) only that client gets the signal.
    void emit(const char *signal, GVariant *params, const std::string &destination = "");

    // Whether the call comes from GNOME Shell (the current owner of
    // org.gnome.Shell), for methods other clients must not use. The
    // environment variable NKB_ALLOW_ANY_CALLER=1 lifts this for testing.
    bool caller_is_shell(GDBusMethodInvocation *inv) const;

    // Returns false if the name could not be owned (another daemon runs without --replace).
    void start(bool replace, std::function<void(bool ok)> on_ready);

private:
    static void on_call(GDBusConnection *, const gchar *, const gchar *, const gchar *,
                        const gchar *method, GVariant *params, GDBusMethodInvocation *inv,
                        gpointer self);

    std::map<std::string, Handler> handlers_;
    GDBusConnection *conn_ = nullptr;
    std::string shell_owner_;  // unique name owning org.gnome.Shell, or ""
    guint shell_watch_ = 0;
    GDBusNodeInfo *node_ = nullptr;
    std::function<void(bool)> on_ready_;
};

// Reply helpers.
void reply_string(GDBusMethodInvocation *inv, const std::string &s);
void reply_empty(GDBusMethodInvocation *inv);
void reply_error(GDBusMethodInvocation *inv, const std::string &message);

}  // namespace nkb
