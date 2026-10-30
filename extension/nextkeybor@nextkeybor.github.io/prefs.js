import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME = 'io.github.nextkeybor.Daemon';
const OBJECT_PATH = '/io/github/nextkeybor/Daemon';

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3', 'tiny.en', 'base.en', 'small.en'];
const PROVIDERS = [['openverse', 'Openverse (no key)'], ['giphy', 'GIPHY'], ['klipy', 'KLIPY']];
const RATINGS = [['g', 'G'], ['pg', 'PG'], ['pg-13', 'PG-13'], ['r', 'R']];
const ENGINES = [['auto', 'Automatic'], ['whisper', 'On this computer (whisper.cpp)'], ['groqtype', 'GroqType (Groq cloud)']];
const GROQTYPE_URL = 'https://github.com/dixonSolutions/GroqType';
const GIPHY_KEY_URL = 'https://developers.giphy.com/dashboard/?create=true';
const KLIPY_KEY_URL = 'https://partner.klipy.com/';

// GroqType's CLI, wherever its installer put it.
function groqtypePath() {
    const found = GLib.find_program_in_path('groqtype');
    if (found)
        return found;
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'groqtype']);
    return GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Editable list of text shortcuts (setting text-shortcuts, a{ss}): typing a
// shortcut and a space types its phrase.
function shortcutsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Text shortcuts',
        description: 'Type a shortcut and a space (or punctuation) to type its phrase',
    });
    const rows = [];
    const read = () => settings.get_value('text-shortcuts').deepUnpack();
    const write = map => settings.set_value('text-shortcuts', new GLib.Variant('a{ss}', map));

    const shortcut = new Adw.EntryRow({title: 'Shortcut'});
    const phrase = new Adw.EntryRow({title: 'Phrase'});
    const add = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Add'});
    add.add_css_class('flat');
    phrase.add_suffix(add);
    const addShortcut = () => {
        const key = shortcut.text.trim();
        if (!key || /\s/.test(key) || !phrase.text.trim())
            return;
        write({...read(), [key]: phrase.text.trim()});
        shortcut.text = '';
        phrase.text = '';
    };
    add.connect('clicked', addShortcut);
    phrase.connect('entry-activated', addShortcut);
    group.add(shortcut);
    group.add(phrase);

    const sync = () => {
        for (const row of rows.splice(0))
            group.remove(row);
        for (const [key, text] of Object.entries(read()).sort()) {
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(key, -1), subtitle: GLib.markup_escape_text(text, -1)});
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Remove'});
            remove.add_css_class('flat');
            remove.connect('clicked', () => {
                const map = read();
                delete map[key];
                write(map);
            });
            row.add_suffix(remove);
            group.add(row);
            rows.push(row);
        }
    };
    settings.connect('changed::text-shortcuts', sync);
    sync();
    return group;
}

function entryRow(settings, key, title, password = false) {
    const row = password
        ? new Adw.PasswordEntryRow({title})
        : new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// A button on a row that opens a web page, e.g. where to get an API key.
function addLink(row, label, uri) {
    const button = new Gtk.Button({label, valign: Gtk.Align.CENTER, tooltip_text: uri});
    button.add_css_class('flat');
    button.connect('clicked', () =>
        new Gtk.UriLauncher({uri}).launch(row.get_root(), null, null));
    row.add_suffix(button);
    return row;
}

function comboRow(settings, key, title, choices, subtitle = '') {
    const model = new Gtk.StringList();
    let values = choices.map(c => (Array.isArray(c) ? c[0] : c));
    const current = settings.get_string(key);
    if (!values.includes(current)) {
        choices = [...choices, current];
        values = [...values, current];
    }
    for (const c of choices)
        model.append(Array.isArray(c) ? c[1] : c);
    const row = new Adw.ComboRow({title, subtitle, model});
    row.selected = Math.max(0, values.indexOf(current));
    row.connect('notify::selected', () => {
        const v = values[row.selected];
        if (v !== undefined && v !== settings.get_string(key))
            settings.set_string(key, v);
    });
    return row;
}

function spinRow(settings, key, title, lower, upper, subtitle = '') {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function callDaemon(method, params = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, BUS_NAME, method, params, null,
            Gio.DBusCallFlags.NONE, 3000, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export default class NextKeyBorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);

        // --- General / status
        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'input-keyboard-symbolic'});
        window.add(general);

        const statusGroup = new Adw.PreferencesGroup({title: 'Daemon'});
        const statusRow = new Adw.ActionRow({title: 'nextkeybord', subtitle: 'Checking…'});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER});
        refresh.add_css_class('flat');
        statusRow.add_suffix(refresh);
        statusGroup.add(statusRow);
        const kbRow = new Adw.ActionRow({title: 'Physical keyboards', subtitle: '—'});
        statusGroup.add(kbRow);
        general.add(statusGroup);

        // Filled in with the GroqType section on the Dictation page.
        let syncGroq = () => {};
        const updateStatus = async () => {
            try {
                const [json] = await callDaemon('GetStatus');
                const s = JSON.parse(json);
                const speech = s.speech ?? {};
                syncGroq(speech);
                statusRow.subtitle = [
                    `Running · v${s.version ?? '?'}`,
                    `speech model ${speech.model ?? '?'}${speech.model_ready ? '' : ' (not downloaded)'}`,
                    `GIFs: ${s.gif_provider ?? '?'}`,
                ].join(' · ');
                const k = s.keyboard ?? {};
                kbRow.subtitle = [
                    k.physical?.length ? k.physical.join(', ') : 'none',
                    k.tablet_mode ? 'tablet mode' : null,
                    k.unreadable_devices ? 'can\u2019t read input devices (join the \u201cinput\u201d group)' : null,
                    `OSK ${k.osk_enabled ? 'on' : 'off'}`,
                ].filter(Boolean).join(' · ');
            } catch (e) {
                statusRow.subtitle = `Not running: ${e.message}. Start it with: systemctl --user start nextkeybord`;
                kbRow.subtitle = '—';
            }
        };
        refresh.connect('clicked', () => updateStatus());
        updateStatus();

        const fixes = new Adw.PreferencesGroup({title: 'On-screen keyboard fixes'});
        fixes.add(switchRow(settings, 'disable-bounce-keys', 'Keep Bounce Keys off',
            'GNOME\u2019s Bounce Keys drops quick repeated keys, such as Backspace taps'));
        fixes.add(switchRow(settings, 'chromium-tap-fix', 'Open in Chromium, Electron and Qt apps',
            'Show the keyboard when tapping text fields that GNOME misses'));
        fixes.add(switchRow(settings, 'fix-auto-capitalization', 'Fix random capital letters',
            'Stop Shift latching after backspace in terminals and browsers'));
        general.add(fixes);

        const auto = new Adw.PreferencesGroup({
            title: 'Physical keyboard detection',
            description: 'System-wide: the daemon watches all input devices and the tablet-mode switch.',
        });
        auto.add(switchRow(settings, 'auto-toggle-osk', 'Automatic on-screen keyboard',
            'Enable it only when no physical keyboard is usable'));
        auto.add(switchRow(settings, 'hide-osk-on-typing', 'Hide when typing on a physical keyboard'));
        auto.add(switchRow(settings, 'notify-keyboard-changes', 'Notify on changes'));
        general.add(auto);

        // --- Typing
        const typing = new Adw.PreferencesPage({title: 'Typing', icon_name: 'format-text-plain-symbolic'});
        window.add(typing);
        const sugg = new Adw.PreferencesGroup({title: 'Suggestions'});
        sugg.add(switchRow(settings, 'suggestions-enabled', 'Word suggestions'));
        sugg.add(switchRow(settings, 'autocorrect', 'Autocorrect',
            'Fix clear typos when you finish a word; Backspace right after puts back what you typed'));
        sugg.add(switchRow(settings, 'auto-space', 'Add a space after a suggestion'));
        sugg.add(switchRow(settings, 'emoji-suggestions', 'Emoji suggestions',
            'Offer an emoji for the word you just typed ("pizza" → 🍕)'));
        sugg.add(switchRow(settings, 'double-space-period', 'Double-tap space for a period'));
        sugg.add(switchRow(settings, 'learn-words', 'Learn new words', 'Stored only on this computer; never in password fields'));
        sugg.add(entryRow(settings, 'active-language', 'Dictionary language (e.g. en_US, pl_PL)'));
        typing.add(sugg);
        typing.add(shortcutsGroup(settings));
        const holds = new Adw.PreferencesGroup({title: 'Keys'});
        holds.add(switchRow(settings, 'hold-for-numbers', 'Hold for numbers and symbols',
            'Long-press the top row for digits, other letters for symbols'));
        holds.add(switchRow(settings, 'number-row', 'Number row',
            'A row of digits above the letters; hold a digit for fractions and superscripts'));
        holds.add(switchRow(settings, 'swipe-typing', 'Swipe typing',
            'Slide across the letters to type a word; lift to finish'));
        holds.add(switchRow(settings, 'key-popups', 'Key popups',
            'Show the character above a key while you press it'));
        holds.add(switchRow(settings, 'space-cursor', 'Move the cursor with the space bar',
            'Slide along the space bar to move the text cursor'));
        holds.add(switchRow(settings, 'swipe-log', 'Log swipes to improve swipe typing',
            'Keeps your swipes and the words you meant in ~/.local/share/nextkeybor; never sent anywhere'));
        holds.add(switchRow(settings, 'floating', 'Floating keyboard',
            'A panel you drag by its top bar; it opens where you left it'));
        holds.add(spinRow(settings, 'float-width', 'Floating width', 30, 100, 'Percent of the screen width'));
        holds.add(switchRow(settings, 'show-indicator', 'Keyboard button in the top bar',
            'Tap to show or hide the keyboard; hold for more'));
        holds.add(spinRow(settings, 'height-landscape', 'Height in landscape', 15, 60,
            'Percent of the screen; you can also drag the handle on top of the keyboard'));
        holds.add(spinRow(settings, 'height-portrait', 'Height in portrait', 15, 60,
            'Percent of the screen'));
        typing.add(holds);

        // --- Dictation
        const speech = new Adw.PreferencesPage({title: 'Dictation', icon_name: 'audio-input-microphone-symbolic'});
        window.add(speech);
        const sp = new Adw.PreferencesGroup({
            title: 'Speech to text',
            description: 'Runs locally with whisper.cpp. Long-press the microphone key to pick a language.',
        });
        sp.add(entryRow(settings, 'speech-language', 'Language (auto, en, pl, de, …)'));
        sp.add(comboRow(settings, 'speech-model', 'Model', MODELS,
            'Bigger is more accurate but slower. Download models from the keyboard’s language panel.'));
        sp.add(spinRow(settings, 'speech-threads', 'Threads', 0, 64, '0 = automatic'));
        sp.add(spinRow(settings, 'speech-max-seconds', 'Maximum length (seconds)', 5, 600));
        sp.add(switchRow(settings, 'speech-silence-stop', 'Stop after a pause'));
        speech.add(sp);

        // GroqType: optional cloud transcription; its key lives in its config.
        const groq = new Adw.PreferencesGroup({
            title: 'Cloud transcription with GroqType',
            description: 'Faster and more accurate than a local model, if GroqType is installed and has a Groq API key. ' +
                'Audio is then sent to Groq. Without it, dictation stays on this computer.',
        });
        groq.add(comboRow(settings, 'speech-engine', 'Engine', ENGINES,
            'Automatic uses GroqType when it is set up, else the local model'));
        const groqStatus = new Adw.ActionRow({title: 'GroqType', subtitle: 'Checking…'});
        const groqLink = new Gtk.Button({label: 'Get GroqType', valign: Gtk.Align.CENTER});
        groqLink.connect('clicked', () =>
            new Gtk.UriLauncher({uri: GROQTYPE_URL}).launch(window, null, null));
        groqStatus.add_suffix(groqLink);
        groq.add(groqStatus);
        const groqKey = new Adw.PasswordEntryRow({
            title: 'Groq API key (saved in GroqType’s config)',
            show_apply_button: true,
        });
        groqKey.connect('apply', () => {
            const program = groqtypePath();
            const key = groqKey.text.trim();
            if (!program || !key)
                return;
            const proc = Gio.Subprocess.new([program, 'config', 'api-key', key],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                const [, , err] = p.communicate_utf8_finish(res);
                groqKey.text = '';
                groqStatus.subtitle = p.get_successful() ? 'API key saved' : `Could not save the key: ${err?.trim()}`;
                updateStatus();
            });
        });
        groq.add(groqKey);
        speech.add(groq);
        syncGroq = speechStatus => {
            const installed = !!groqtypePath();
            groqLink.visible = !installed;
            groqKey.sensitive = installed;
            if (!installed)
                groqStatus.subtitle = 'Not installed';
            else if (!speechStatus.groqtype_key)
                groqStatus.subtitle = 'Installed; needs a Groq API key (free at console.groq.com/keys)';
            else
                groqStatus.subtitle = `Ready · dictation uses ${speechStatus.engine === 'groqtype' ? 'GroqType' : 'the local model'}`;
        };
        updateStatus();

        // --- GIFs
        const gifs = new Adw.PreferencesPage({title: 'GIFs', icon_name: 'image-x-generic-symbolic'});
        window.add(gifs);
        const prov = new Adw.PreferencesGroup({
            title: 'Online GIFs and stickers',
            description: 'Openverse works without a key but has few reaction GIFs. For GIPHY or KLIPY, use Get a key to sign up and create one; until a key is set, searches use Openverse. Favourites and your own GIFs work offline.',
        });
        prov.add(comboRow(settings, 'gif-provider', 'Provider', PROVIDERS));
        prov.add(addLink(entryRow(settings, 'giphy-api-key', 'GIPHY API key', true), 'Get a key', GIPHY_KEY_URL));
        prov.add(addLink(entryRow(settings, 'klipy-api-key', 'KLIPY API key', true), 'Get a key', KLIPY_KEY_URL));
        prov.add(comboRow(settings, 'gif-content-rating', 'Content rating', RATINGS));
        prov.add(spinRow(settings, 'gif-cache-mb', 'Cache size (MB)', 20, 5000));
        gifs.add(prov);

        const own = new Adw.PreferencesGroup({title: 'Your library'});
        const importRow = new Adw.ActionRow({
            title: 'Add your own GIFs and stickers',
            subtitle: 'Also available from the + button in the keyboard’s GIF panel',
        });
        const importButton = new Gtk.Button({label: 'Add…', valign: Gtk.Align.CENTER});
        importButton.connect('clicked', () => {
            callDaemon('ImportOwnMedia', new GLib.Variant('(ass)', [[], ''])).catch(e => {
                importRow.subtitle = `Daemon not running: ${e.message}`;
            });
        });
        importRow.add_suffix(importButton);
        own.add(importRow);
        gifs.add(own);
    }
}
