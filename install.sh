#!/usr/bin/env bash
# Build and install NextKeyBor for the current user (no root needed).
#   ./install.sh              build + install daemon, schema, services, extension
#   ./install.sh --uninstall  remove everything this script installed
#   ./install.sh --with-groqtype  also set up GroqType's CLI for cloud dictation
#                             (optional; asks for a Groq API key)
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

UUID=nextkeybor@nextkeybor.github.io
PREFIX=${PREFIX:-$HOME/.local}
BINDIR=$PREFIX/bin
DATADIR=${XDG_DATA_HOME:-$HOME/.local/share}
UNITDIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
SCHEMADIR=$DATADIR/glib-2.0/schemas
DBUSDIR=$DATADIR/dbus-1/services
EXTDIR=$DATADIR/gnome-shell/extensions/$UUID

# Older per-machine daemon that NextKeyBor replaces.
OLD_DAEMON=osk-keyboard-daemon.service

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

uninstall() {
    say "Stopping nextkeybord"
    systemctl --user disable --now nextkeybord.service 2>/dev/null || true
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -f "$BINDIR/nextkeybord" "$UNITDIR/nextkeybord.service" \
          "$DBUSDIR/io.github.nextkeybor.Daemon.service" \
          "$SCHEMADIR/io.github.nextkeybor.gschema.xml"
    rm -rf "$EXTDIR"
    glib-compile-schemas "$SCHEMADIR" 2>/dev/null || true
    systemctl --user daemon-reload
    if [[ -f $UNITDIR/$OLD_DAEMON ]]; then
        say "Re-enabling $OLD_DAEMON"
        systemctl --user enable --now "$OLD_DAEMON" || true
    fi
    say "Removed. User data is kept in $DATADIR/nextkeybor and ~/.cache/nextkeybor."
}

WITH_GROQTYPE=false
[[ ${1:-} == --with-groqtype ]] && WITH_GROQTYPE=true

if [[ ${1:-} == --uninstall ]]; then
    uninstall
    exit 0
fi

say "Building daemon"
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release ${CMAKE_ARGS:-}
cmake --build build

say "Installing daemon to $BINDIR"
install -Dm755 build/daemon/nextkeybord "$BINDIR/nextkeybord"

say "Installing settings schema"
install -Dm644 data/io.github.nextkeybor.gschema.xml "$SCHEMADIR/io.github.nextkeybor.gschema.xml"
glib-compile-schemas "$SCHEMADIR"

say "Installing user services"
mkdir -p "$UNITDIR" "$DBUSDIR"
sed "s|@BINDIR@|$BINDIR|" data/nextkeybord.service > "$UNITDIR/nextkeybord.service"
sed "s|@BINDIR@|$BINDIR|" data/io.github.nextkeybor.Daemon.service \
    > "$DBUSDIR/io.github.nextkeybor.Daemon.service"
systemctl --user daemon-reload

if systemctl --user is-enabled --quiet "$OLD_DAEMON" 2>/dev/null; then
    say "Disabling $OLD_DAEMON (keyboard detection now lives in nextkeybord)"
    systemctl --user disable --now "$OLD_DAEMON"
fi
systemctl --user enable nextkeybord.service
systemctl --user restart nextkeybord.service

# Bounce Keys drops quick repeated keys (Backspace taps, double letters);
# the daemon keeps it off too (setting: disable-bounce-keys).
if [[ $(gsettings get org.gnome.desktop.a11y.keyboard bouncekeys-enable 2>/dev/null) == true ]]; then
    say "Turning off GNOME's Bounce Keys (it drops quick repeated key presses)"
    gsettings set org.gnome.desktop.a11y.keyboard bouncekeys-enable false
fi

say "Installing GNOME Shell extension"
rm -rf "$EXTDIR"
mkdir -p "$EXTDIR"
cp -r extension/$UUID/. "$EXTDIR/"
mkdir -p "$EXTDIR/schemas" "$EXTDIR/dbus"
cp data/io.github.nextkeybor.gschema.xml "$EXTDIR/schemas/"
cp data/io.github.nextkeybor.Daemon.xml "$EXTDIR/dbus/"
glib-compile-schemas "$EXTDIR/schemas"

# The extension disables osk-tap-fix itself when it first loads, so the
# old fixes keep working until the next login.
# The running shell does not know a freshly copied extension yet, so
# `gnome-extensions enable` fails; add it to the enabled list directly.
gnome-extensions enable "$UUID" 2>/dev/null || python3 - "$UUID" <<'PY'
import sys
from gi.repository import Gio
s = Gio.Settings.new('org.gnome.shell')
uuid = sys.argv[1]
for key, add in (('enabled-extensions', True), ('disabled-extensions', False)):
    cur = list(s.get_strv(key))
    new = (cur + [uuid]) if add and uuid not in cur else [u for u in cur if add or u != uuid]
    s.set_strv(key, new)
Gio.Settings.sync()
PY

if $WITH_GROQTYPE; then
    tools/setup-groqtype.sh
fi

cat <<EOF

NextKeyBor is installed.
  * Log out and back in once so GNOME Shell loads the extension (Wayland cannot reload it live).
  * Download a speech model:  gdbus call --session -d io.github.nextkeybor.Daemon \\
        -o /io/github/nextkeybor/Daemon -m io.github.nextkeybor.Daemon.DownloadSpeechModel base
    (or use the language button on the keyboard).
  * GIF search works as is (Openverse); for GIPHY/KLIPY add a free API key:  gnome-extensions prefs $UUID
  * Optional cloud dictation with GroqType:  ./install.sh --with-groqtype
EOF
