// nextkeybord: the NextKeyBor background service.
//
// Serves io.github.nextkeybor.Daemon on the session bus for the GNOME Shell
// extension: dictation, word suggestions, emoji/symbol search, GIFs and
// stickers, language installation and physical keyboard detection.
#include <cstring>
#include <iostream>

#include <glib-unix.h>

#include "dbus_service.h"
#include "emoji.h"
#include "keyboard_detect.h"
#include "languages.h"
#include "media.h"
#include "predict.h"
#include "speech.h"
#include "util.h"

namespace {

void usage() {
    std::cout << "Usage: nextkeybord [OPTION]\n"
                 "  --replace            take over from a running nextkeybord\n"
                 "  --no-osk-toggle      detect keyboards but never switch the on-screen keyboard\n"
                 "  --transcribe FILE [LANG]  transcribe a 16 kHz mono WAV/raw f32 file and exit\n"
                 "  --suggest TEXT [LANG]     print suggestions and autocorrection for TEXT and exit\n"
                 "  --swipe-bench FILE [LANG]  score the swipe matcher on saved swipes and exit\n"
                 "  --status             print physical keyboard state as JSON and exit\n"
                 "  --version            print the version and exit\n";
}

}  // namespace

// GNOME's Bounce Keys ignores a key pressed again within its delay, which
// swallows quick Backspace taps and double letters, from the on-screen
// keyboard as much as from a real one. Keep it off unless the user tells
// NextKeyBor not to (disable-bounce-keys).
static void keep_bounce_keys_off() {
    GSettingsSchemaSource *src = g_settings_schema_source_get_default();
    GSettingsSchema *schema = src ? g_settings_schema_source_lookup(src, "org.gnome.desktop.a11y.keyboard", TRUE)
                                  : nullptr;
    if (!schema)
        return;
    g_settings_schema_unref(schema);
    static GSettings *a11y = g_settings_new("org.gnome.desktop.a11y.keyboard");
    auto enforce = +[](GSettings *, const gchar *, gpointer) {
        if (nkb::setting_bool("disable-bounce-keys", true) && g_settings_get_boolean(a11y, "bouncekeys-enable")) {
            g_message("turning off Bounce Keys (disable-bounce-keys)");
            g_settings_set_boolean(a11y, "bouncekeys-enable", FALSE);
        }
    };
    g_signal_connect(a11y, "changed::bouncekeys-enable", G_CALLBACK(enforce), nullptr);
    if (nkb::settings())
        g_signal_connect(nkb::settings(), "changed::disable-bounce-keys", G_CALLBACK(enforce), nullptr);
    enforce(a11y, nullptr, nullptr);
}

int main(int argc, char **argv) {
    bool replace = false, manage_osk = true;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--version")) {
            std::cout << "nextkeybord " NKB_VERSION "\n";
            return 0;
        } else if (!strcmp(argv[i], "--status")) {
            std::cout << nkb::keyboard::scan_once().dump(2) << "\n";
            return 0;
        } else if (!strcmp(argv[i], "--transcribe") && i + 1 < argc) {
            return nkb::speech::transcribe_file(argv[i + 1], i + 2 < argc ? argv[i + 2] : "auto");
        } else if (!strcmp(argv[i], "--suggest") && i + 1 < argc) {
            return nkb::predict::print_suggestions(argv[i + 1], i + 2 < argc ? argv[i + 2] : "");
        } else if (!strcmp(argv[i], "--swipe-bench") && i + 1 < argc) {
            return nkb::predict::swipe_bench(argv[i + 1], i + 2 < argc ? argv[i + 2] : "");
        } else if (!strcmp(argv[i], "--replace")) {
            replace = true;
        } else if (!strcmp(argv[i], "--no-osk-toggle")) {
            manage_osk = false;
        } else {
            usage();
            return !strcmp(argv[i], "--help") || !strcmp(argv[i], "-h") ? 0 : 2;
        }
    }

    GMainLoop *loop = g_main_loop_new(nullptr, FALSE);
    auto quit = [](gpointer l) -> gboolean {
        g_main_loop_quit(static_cast<GMainLoop *>(l));
        return G_SOURCE_REMOVE;
    };
    g_unix_signal_add(SIGINT, quit, loop);
    g_unix_signal_add(SIGTERM, quit, loop);

    auto &svc = nkb::Service::get();
    nkb::speech::init();
    nkb::predict::init();
    nkb::languages::init();
    nkb::emoji::init();
    nkb::media::init();

    svc.on("GetStatus", [](GVariant *, GDBusMethodInvocation *inv) {
        std::string provider = nkb::media::effective_provider();
        nkb::json status = {
            {"version", NKB_VERSION},
            {"speech", nkb::speech::status()},
            {"gif_provider", provider},
            {"gif_provider_ready", true},
            {"suggest_language", nkb::predict::active_language()},
            {"keyboard", nkb::keyboard::state()},
        };
        nkb::reply_string(inv, status.dump());
    });

    bool started = false;
    svc.start(replace, [&started, loop, manage_osk](bool ok) {
        if (!ok) {
            // Could not get the name, or another instance replaced us.
            g_main_loop_quit(loop);
            return;
        }
        if (!started) {
            started = true;
            nkb::keyboard::init(manage_osk);
            keep_bounce_keys_off();
        }
    });

    g_main_loop_run(loop);
    g_main_loop_unref(loop);
    return started ? 0 : 1;
}
