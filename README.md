# NextKeyBor

A smarter on-screen keyboard for GNOME on Wayland, made for touchscreens and 2-in-1s such as the Microsoft Surface.

NextKeyBor adds these to GNOME's built-in on-screen keyboard (OSK):

- **🎤 Dictation:** speak and the text goes straight into the app. It runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and you can pick the language (or leave it on auto-detect). Optionally, with [GroqType](https://github.com/dixonSolutions/GroqType) installed and a Groq API key set (in GroqType, or from NextKeyBor's settings), dictation uses Groq's cloud Whisper instead, falling back to the local model when offline.
- **🌐 Languages:** switch the dictation language and your system keyboard layouts. It can also download spell-check dictionaries and language packs through PackageKit, the same system that GNOME Software uses.
- **Autocomplete:** word completion, typo fixes and next-word prediction. It learns the words you type and keeps them only on your machine.
- **Autocorrect:** clear typos are fixed when you finish the word with a space or punctuation ("teh" → "the", "dont" → "don't", "alot" → "a lot"). Texting abbreviations such as "thx", "pls" and "jk" are left as typed. The fix shows in bold in the suggestion bar first. Backspace right after puts back what you typed, and that word is never corrected again. Passwords, terminals, web and email addresses are left alone.
- **Emoji suggestions:** after a word with an emoji of its own, the suggestion bar offers it ("pizza" → 🍕, "thanks" → 🙏); tap to type it.
- **Text shortcuts:** type a shortcut and a space to type its phrase ("omw" → "On my way!"). Edit them in settings.
- **Swipe typing:** slide across the letters and lift; a fading trail follows your finger. The best match is typed, the other matches wait in the suggestion bar, and backspace right after removes the whole word. Matching copes with how real fingers swipe: rounded corners, aiming off-centre, overshooting the last letter.
- **Phone-keyboard touches:**
  - a pressed key shows its character above your finger
  - slide along the space bar to move the cursor
  - double-tap shift for caps lock
  - an optional click sound on each key press (in settings)
  - punctuation or a closing bracket after an automatic space takes the space's place ("word ." → "word. ")
  - the ?123 page stays up while you type digits and symbols, and a space takes you back to the letters
- **Resizable:** drag the handle on top of the keyboard to set its height, separately for landscape and portrait.
- **Floating keyboard:** switch it on from the keyboard button in the top bar (hold it for the menu) or in settings. The keyboard becomes a panel you drag by its top bar; it opens where you left it, whether you tap a text field or the top bar button, and its X closes it.
- **Skins:** pick the keyboard's look under Appearance in settings: follow the shell theme, light, dark, high contrast, Nord, Catppuccin Mocha, or your wallpaper's colours through pywal or matugen. Make your own from a copy of any skin (see [Skins](#skins)); saved changes show on the keyboard straight away.
- **Text editing:** the editing button swaps the keys for a panel with arrows (with Select on, they extend the selection), Home/End, select all, cut, copy, paste, undo, redo and delete. Arrows and delete repeat while held. In a terminal, select all, undo and redo are greyed out, since Ctrl+Z there suspends the running program.
- **Clipboard history:** the clipboard button lists the last 20 texts you copied; tap one to paste it, hold to pin it. Kept in memory only, never on disk. Passwords are skipped when the password manager marks them as secret (KeePassXC and KDE do; most others, and browsers, don't), so turn this off if you copy passwords from one that doesn't.
- **Screenshots:** the camera button opens GNOME's screenshot tool (area, window or screen; picture or video).
- **Hold for special characters:** long-press top-row letters for the digits 1–0. Other keys give common symbols, alongside GNOME's accented letters.
- **Number row:** an optional row of digits above the letters (in settings); hold a digit for fractions and superscripts.
- **Emoji and symbol search:** find emoji by name in your own language (using Unicode CLDR data) and search more than 1,100 symbols (arrows, currency, maths…).
- **GIFs and stickers:** search online results from GIPHY or KLIPY with a free API key, or from Openverse with no key at all (openly licensed, mostly Wikimedia animations). You can:
  - favourite items (saved locally, so they work offline)
  - import your own GIFs through the system file picker
  - search your favourites and your own GIFs too.
- **Physical keyboard detection:** the on-screen keyboard switches on when no real keyboard can be used, and off again when one can. This covers a Type Cover folded back into tablet mode, a Bluetooth or USB keyboard being connected, and typing on a physical keyboard. It is off by default (earlier builds had it on; turn "Automatic on-screen keyboard" back on in settings if you relied on it); it needs read access to `/dev/input` (`sudo usermod -aG input $USER`), and without it the daemon never switches the keyboard on.
- **Fixes for GNOME's keyboard:**
  - The keyboard now opens when you tap text fields in Chromium, Electron and Qt apps. Mutter only opens it for apps that re-enable text input on each tap, which those apps don't do.
  - Shift no longer switches on by itself after every backspace in terminals and Chromium apps.

## How it's built

| Part | Language | What it does |
|---|---|---|
| `daemon/`: `nextkeybord` | C++20 | D-Bus service `io.github.nextkeybor.Daemon`: speech capture and transcription, suggestions, emoji and symbol search, GIF providers and cache, languages, keyboard detection through evdev |
| `extension/` | GJS | GNOME Shell extension that adds the toolbar and panels to the stock OSK. Keyboard UI has to live in the shell on Wayland, so it can't be a C++ app. |
| `data/` | | D-Bus interface, GSettings schema, systemd and D-Bus activation files |

## Install

Requires GNOME Shell 50, CMake, Ninja, a C++20 compiler, GLib and libcurl development headers, PipeWire (`pw-record`) and the Unicode CLDR emoji annotations (for emoji search and suggestions). whisper.cpp and nlohmann/json are downloaded automatically when you build.

```sh
# Fedora
sudo dnf install cmake ninja-build gcc-c++ glib2-devel libcurl-devel pipewire-utils cldr-emoji-annotation
# Debian / Ubuntu
sudo apt install cmake ninja-build g++ libglib2.0-dev libcurl4-openssl-dev pipewire-bin unicode-cldr-core
./install.sh            # builds and installs for your user only, no root needed
```

Then log out and back in. Download a speech model from the 🌐 button on the keyboard. The `base` model is 142 MB and supports many languages.

GIF search works straight away through Openverse. For GIPHY or KLIPY results, add a free API key: `gnome-extensions prefs nextkeybor@nextkeybor.github.io`.

For cloud dictation with GroqType, run `./install.sh --with-groqtype` (add `GROQ_API_KEY=...` in front to save your key). It downloads only GroqType's command-line tool, which needs no root; a full GroqType install works too.

To uninstall, run `./install.sh --uninstall`.

## Skins

A skin is a JSON file in `~/.local/share/nextkeybor/skins/`. Every value is optional; colours are `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgba(…)`, sizes are pixels:

| Key | What it sets |
|---|---|
| `name` | name in the picker |
| `background`, `background-image` | keyboard background; the image (absolute, `~/`, or relative to the skin file) covers it |
| `key`, `key-text` | letter keys |
| `special-key`, `special-key-text` | shift, backspace, enter, ?123 and the like |
| `accent`, `accent-text` | caps lock and selected buttons (default: the system accent colour) |
| `toolbar-text` | suggestion bar, toolbar and panels |
| `key-radius`, `key-gap` | key corners, and the space between keys (stock: 8) |
| `key-border-width`, `key-border-color`, `key-shadow` | key outline; `false` drops the shadow |
| `font`, `font-weight` | font family; `normal` or `bold` |
| `css` | extra CSS added after the rest |

A `.css` file in the same folder works as a skin too, for full control (the keyboard is `#keyboard`, its keys `.keyboard-key`, NextKeyBor's parts `.nkb-*`). Settings → Appearance → Copy writes an editable copy of the chosen skin.

To follow the wallpaper with [matugen](https://github.com/InioX/matugen), add this to `~/.config/matugen/config.toml`, run matugen, and pick "Wallpaper (matugen)":

```toml
[templates.nextkeybor]
input_path = '~/.local/share/gnome-shell/extensions/nextkeybor@nextkeybor.github.io/templates/matugen.json'
output_path = '~/.local/share/nextkeybor/skins/matugen.json'
```

With [pywal](https://github.com/dylanaraps/pywal), pick "Wallpaper (pywal)"; it reads `~/.cache/wal/colors.json` after each run of `wal`.

## Tuning suggestions and swipe typing

The daemon can be tried without the keyboard:

```bash
nextkeybord --suggest "i went to teh"          # suggestions and autocorrection for this text
tools/swipe_bench.py > /tmp/swipes.jsonl         # 500 human-like swipes of common words
nextkeybord --swipe-bench /tmp/swipes.jsonl      # top-1 / top-4 accuracy, misses, slowest swipes
```

To measure swipe typing on your own swipes, turn on "Log swipes to improve swipe typing" in settings. Each swipe is saved with the word you meant (the one you kept, the alternative you picked, or what you typed or swiped after undoing it) to `~/.local/share/nextkeybor/swipe-log.jsonl`, with the two words before it and nothing more of what you wrote, and `nextkeybord --swipe-bench` reads that file too. Past 5 MB the log starts again, keeping the previous one as `swipe-log.old.jsonl`.

## Data and privacy

Everything stays on your machine unless you search for GIFs or stickers, which sends your query to the provider you picked.

- Learned words, favourites, your own GIF library and the swipe log (only when turned on): `~/.local/share/nextkeybor/`
- Cache: `~/.cache/nextkeybor/`
- Clipboard history: in memory only, never written to disk; kept while the screen is locked, gone when you log out or turn it off.

## Licence

GPL-3.0-or-later. Word frequency lists come from [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (CC-BY-SA 4.0) and are downloaded the first time each language is used.

## Testing without logging out

`tools/nested/` runs a second GNOME Shell with its own D-Bus session and a copy of your settings, loads the installed NextKeyBor, and drives it with touches through Mutter's remote desktop API:

```bash
./install.sh
tools/nested/restart.sh /tmp/nkb                                   # session + a text box to type into
tools/nested/drive.py /tmp/nkb 'tap 700 450; wait 1; shot /tmp/k.png'
```

With `mutter-devkit` installed (`sudo dnf install mutter-devkit`) the session also opens as a window you can use yourself; without it, `tools/nested/view.py /tmp/nkb` shows it live (view only).

More in `tools/nested/`: `type_test.py` taps out "teh" and checks autocorrect and its undo; `swipe_test.py` swipes words with human-like finger paths (or `--straight` lines) and checks what gets typed (`--grid` gives the key positions if your keyboard size differs); `NKB_EXTENSIONS="['nextkeybor@nextkeybor.github.io']" tools/nested/restart.sh` limits the session to chosen extensions.
