// Everything NextKeyBor adds to one instance of the stock OSK: the toolbar,
// the panel host, the hooks on its KeyboardController, text tracking for
// suggestions, dictation and media pasting. destroy() puts the stock
// keyboard back exactly as it was.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardPanel} from './clipboard.js';
import {waitForSignal} from './daemon.js';
import {EditPanel} from './editPanel.js';
import {EmojiPanel, LanguagePanel, MediaPanel} from './panels.js';
import {KeyGestures} from './gestures.js';
import {LayoutPanel} from './layoutPanel.js';
import {OneHandedStrip, oneHandedWidth, splitGap} from './layoutModes.js';
import {SwipeTyper, letterKeyCentres} from './swipe.js';
import {connectTap, iconButton, labelButton, setChecked} from './widgets.js';

const MAX_SUGGESTIONS = 3;
const MAX_BUFFER = 400;
const SUGGEST_DELAY_MS = 90;
const LEARN_WORD_BATCH = 8;
const MEDIA_READY_TIMEOUT_MS = 30000;
const LONG_DELETE_MS = 600;
const STRIP_RATIO = 0.6;
// The keyboard, including an open panel, never covers more than this much of
// the screen.
export const MAX_HEIGHT_RATIO = 0.62;
const SWIPE_CHOICES = 4;
const SCREENSHOT_DELAY_MS = 250;
const KEY_GAP_MS = 15;
const DOUBLE_SPACE_MS = 1000;
const BOUNCE_MARGIN_MS = 30;
const SPLIT_CHECK_MS = 250;
const MAX_DELETE_WORDS = 30;
const DELETE_TAP_MS = 300;

const WORD_TAIL = /[\p{L}\p{N}_'’-]*$/u;
// The word just finished with a space, for emoji suggestions.
const FINISHED_WORD = /([\p{L}'’-]+) $/u;
// A word finished with one of these is autocorrected.
const AUTOCORRECT_TRIGGER = /^[ .,!?;:]$/;
// Typed right after an automatic space, these take its place: "word. ",
// "(like this) ".
const SPACE_BEFORE = /^[.,!?;:)]$/;
const TERMINAL_WM_CLASS = /term|console|ptyxis|kitty|alacritty|wezterm|foot|konsole|tilix|terminator|blackbox|guake|tilda/i;

function lastWord(text) {
    return text.match(WORD_TAIL)[0];
}

// How many characters before the end of text the last 1, 2, ... words
// take, each with the spaces after it, up to max words.
function wordEnds(text, max) {
    const chars = [...text];
    const ends = [];
    let i = chars.length;
    while (ends.length < max && i > 0) {
        while (i > 0 && /\s/u.test(chars[i - 1]))
            i--;
        while (i > 0 && !/\s/u.test(chars[i - 1]))
            i--;
        ends.push(chars.length - i);
    }
    return ends;
}

function matchCase(word, partial) {
    if (!partial)
        return word;
    const first = [...partial][0];
    if (partial.length > 1 && partial === partial.toUpperCase() && partial !== partial.toLowerCase())
        return word.toUpperCase();
    if (first !== first.toLowerCase())
        return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
}

function loadBytes(path) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                const [, contents] = file.load_contents_finish(res);
                resolve(contents);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class KeyboardUi {
    constructor(keyboard, {settings, daemon, clipboard, openPreferences, floating = null, soundFile = null}) {
        this._kb = keyboard;
        this._settings = settings;
        this._daemon = daemon;
        this._clipboard = clipboard;
        this._openPreferences = openPreferences;
        this._floating = floating;

        this._panel = null;
        this._buffer = '';
        this._pendingLearn = '';
        this._lastCommitTime = 0;
        this._lastSurroundingTime = 0;
        this._suggestId = 0;
        this._suggestSerial = 0;
        this._capDeleteDown = false;
        this._swallowRelease = false;
        this._deletePressTime = 0;
        this._ignoreDeleteUntil = 0;
        this._deleteEnds = null; // see _startWordDelete
        this._dictation = {id: null, state: 'idle'};
        this.extraHeight = 0;

        this._swipeResult = null; // {text, lead, space, words, picked, log, retry} of the last swiped word
        this._swipeRetype = null; // log entry of an undone swipe, waiting for the word typed instead
        this._keyQueue = [];
        this._keyQueueId = 0;
        this._a11yKeyboard = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.keyboard'});
        this._deleteHandled = false; // a Backspace press already undid a swipe or correction
        this._autocorrect = null; // {partial, fix}: what finishing the current word will make it
        this._autocorrectSerial = 0;
        this._corrected = null; // {original, fix, sep} of the correction just made
        this._keepWord = ''; // a word whose correction was undone
        this._autoSpace = false; // the last character typed is a space we added (suggestion, swipe)
        this._sentLayout = ''; // the key layout last sent to the daemon, as JSON

        this._buildToolbar();
        this._buildResizeHandle();
        this._buildPanelHost();
        this._hookController();

        this._oneHanded = new OneHandedStrip(keyboard, settings, floating);

        this._swipe = new SwipeTyper(keyboard, {
            enabled: () => this._settings.get_boolean('swipe-typing') && !this._panel &&
                this._daemon.available && !this._isPassword(),
            onSwipe: (keys, path, shifted) => this._onSwipe(keys, path, shifted)
                .catch(e => console.error(`NextKeyBor: swipe failed: ${e}`)),
        });

        this._gestures = new KeyGestures(keyboard, {
            settings,
            enabled: () => !this._panel,
            moveCursor: keyval => {
                this._settleSwipe();
                this._corrected = null;
                this._pressKeys([keyval]);
            },
            cursorMoved: () => this._resetText(),
            deleteWords: {
                start: () => this._startWordDelete(),
                pick: n => this._pickWordDelete(n),
                finish: n => this._finishWordDelete(n),
            },
            soundFile,
        });

        Main.inputMethod.connectObject('surrounding-text-set', () => {
            this._lastSurroundingTime = GLib.get_monotonic_time();
            this._scheduleSuggest(20);
        }, this);

        keyboard._focusTracker?.connectObject(
            'focus-changed', () => this._resetText(),
            'window-changed', () => this._resetText(), this);
        keyboard._keyboardController.connectObject(
            'purpose-changed', () => {
                this._resetText();
                this._syncVisibility();
            }, this);
        // The input region follows allocations, not the slide-in translation;
        // refresh it so a floating keyboard's top edge takes touches too.
        keyboard.connectObject('notify::translation-y',
            () => Main.layoutManager._queueUpdateRegions(), this);
        // Not notify::width: relayouts emit it too, and _layoutPanel relayouts.
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._layoutPanel();
            this._queueSplitCheck();
        }, this);
        // The split keyboard's gap depends on the keys' height (and turns
        // off in portrait).
        keyboard._aspectContainer?.connectObject('notify::height', () => this._queueSplitCheck(), this);
        keyboard.connectObject('visibility-changed', () => {
            if (!keyboard.visible) {
                this.closePanel();
                this._settleSwipe();
                this._flushLearn();
            } else {
                this._scheduleSuggest(0);
            }
        }, this);

        daemon.connectObject(
            'available-changed', () => this._syncVisibility(),
            'DictationState', (_d, id, state) => this._onDictationState(id, state),
            'DictationLevel', (_d, level) => this._onDictationLevel(level),
            'DictationResult', (_d, id, text) => this._onDictationResult(id, text),
            'DictationError', (_d, id, message) => this._onDictationError(id, message),
            this);

        settings.connectObject('changed', (_s, key) => {
            if (key === 'speech-language')
                this._syncMicLabel();
            if (key === 'one-handed')
                this._kb._relayout();
            if (key === 'floating' || key === 'one-handed')
                this._queueSplitCheck();
            if (key === 'gif-provider' || key.endsWith('-api-key') || key === 'floating' ||
                key === 'clipboard-history')
                this._syncVisibility();
            if (key === 'suggestions-enabled') {
                this._syncVisibility();
                this._ctrl?.setOskCompletion(Main.keyboard.visible)
                    .catch(e => console.error(`NextKeyBor: OSK completion: ${e}`));
            }
        }, this);

        this._syncMicLabel();
        this._syncVisibility();
    }

    destroy() {
        this._destroyed = true;
        this._flushLearn();
        if (this._suggestId)
            GLib.source_remove(this._suggestId);
        this._suggestId = 0;
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = 0;
        if (this._keyQueueId)
            GLib.source_remove(this._keyQueueId);
        this._keyQueueId = 0;
        if (this._splitCheckId)
            GLib.source_remove(this._splitCheckId);
        this._splitCheckId = 0;
        if (this._dictation.id && this._dictation.state === 'recording')
            this._daemon.cancelDictation(this._dictation.id).catch(() => {});

        Main.inputMethod.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._daemon.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._swipe.destroy();
        this._gestures.destroy();
        this._oneHanded.destroy();

        const kb = this._kb;
        const alive = !kb._nkbDestroyed;
        if (alive) {
            kb._focusTracker?.disconnectObject(this);
            kb._keyboardController?.disconnectObject(this);
            kb._aspectContainer?.disconnectObject(this);
            kb.disconnectObject(this);
            this._unhookController();
            this.closePanel();
            this._endResize();
            this._toolbar.destroy();
            this._resizeStrip.destroy();
            this._panelHost.destroy();
            if (kb._suggestions) {
                kb._suggestions.disconnectObject(this);
                kb._suggestions.visible = true;
            }
            kb._aspectContainer?.show();
        }
        this.extraHeight = 0;
        this._kb = null;
    }

    // Forget touches in progress, before the keys they started on go away.
    resetGestures() {
        this._swipe.reset();
        this._gestures.reset();
    }

    // ---- backspace swipe ---------------------------------------------------

    // A slide left from backspace began: returns how many words it can
    // delete. Without the text (terminals, apps that do not report it) the
    // words are deleted blind, with Ctrl+Backspace.
    _startWordDelete() {
        this._settleSwipe();
        this._corrected = null;
        const context = this._context();
        this._deleteEnds = context ? wordEnds(context, MAX_DELETE_WORDS) : null;
        return this._deleteEnds?.length ?? MAX_DELETE_WORDS;
    }

    // Show what lifting the finger will delete.
    _pickWordDelete(n) {
        if (n === 0) {
            this._syncMic();
            return;
        }
        const ends = this._deleteEnds;
        if (ends) {
            const chars = [...this._context()];
            const text = chars.slice(chars.length - ends[n - 1]).join('').trim();
            this._showToolbarStatus(`Delete “${text}”`);
        } else {
            this._showToolbarStatus(n === 1 ? 'Delete 1 word' : `Delete ${n} words`);
        }
    }

    _finishWordDelete(n) {
        this._ignoreDeleteUntil = GLib.get_monotonic_time() + DELETE_TAP_MS * 1000;
        this._syncMic();
        const ends = this._deleteEnds;
        this._deleteEnds = null;
        if (n === 0)
            return;
        this._autoSpace = false;
        this._kb._nkbLastCommit = null;
        if (ends) {
            this._replaceBeforeCursor(ends[n - 1], '');
        } else {
            this._resetText();
            this._pressKeys(new Array(n).fill({keyval: Clutter.KEY_BackSpace, modifiers: [Clutter.KEY_Control_L]}));
        }
    }

    // ---- split keyboard ----------------------------------------------------

    _queueSplitCheck() {
        if (this._splitCheckId)
            GLib.source_remove(this._splitCheckId);
        this._splitCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPLIT_CHECK_MS, () => {
            this._splitCheckId = 0;
            this._checkSplit();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Rebuild the keys when the split gap they were built with no longer
    // fits (first allocation, height or orientation changed), and fit a
    // one-handed keyboard to its keys.
    _checkSplit() {
        const kb = this._kb;
        const keys = kb?._aspectContainer;
        if (!keys?.visible || !keys.height)
            return;
        kb._nkbKeysHeight = keys.height;
        const monitor = Main.layoutManager.keyboardMonitor;
        const oneWidth = oneHandedWidth(kb, monitor, this._settings, this._floating);
        if (oneWidth && Math.abs(oneWidth - kb.width) > 1)
            kb._relayout();
        // Measured on the letters (the level with the number row, if any).
        const want = splitGap(kb, this._settings, this._floating, kb._nkbSplitWidth ?? 0,
            this._settings.get_boolean('number-row'));
        if (Math.abs(want - (kb._nkbSplitGap ?? 0)) < 1 && (want > 0) === (kb._nkbSplitGap > 0))
            return;
        try {
            kb._updateKeys();
        } catch (e) {
            console.error(`NextKeyBor: rebuilding keys failed: ${e}`);
        }
    }

    // GNOME's own screenshot UI (area, window or screen; picture or video).
    // Close the keyboard first so it is not in the shot.
    _openScreenshotUi() {
        this.closePanel();
        this._kb.close(true);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCREENSHOT_DELAY_MS, () => {
            Main.screenshotUI.open().catch(e => console.error(`NextKeyBor: screenshot UI: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- resize handle ---------------------------------------------------

    // A strip on top of the keyboard; dragging it sets the keyboard height
    // for the current orientation.
    _buildResizeHandle() {
        this._resizeStrip = new St.Widget({
            style_class: 'nkb-resize-strip',
            reactive: true,
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
            accessible_name: 'Resize keyboard',
        });
        this._resizeStrip.add_child(new St.Widget({
            style_class: 'nkb-resize-pill',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._resizeStrip.connect('event', (_a, event) => this._onResizeEvent(event));
        this._resizeGrab = null;
        this._kb.insert_child_at_index(this._resizeStrip, 0);
    }

    _onResizeEvent(event) {
        const T = Clutter.EventType;
        const type = event.type();
        if (type === T.BUTTON_PRESS || type === T.TOUCH_BEGIN) {
            if (!this._dragging) {
                this._dragging = true;
                this._resizeSlot = event.get_event_sequence()?.get_slot() ?? -1;
                // Floating: the strip moves the keyboard instead of sizing it.
                this._moveStart = this._floating?.enabled
                    ? [...event.get_coords(), ...this._floating.position()] : null;
                // A finger's touches already stay with this strip. Grab only
                // for the mouse: a stage grab takes keyboard focus from the
                // app, and the keyboard closes with it.
                if (type === T.BUTTON_PRESS)
                    this._resizeGrab = global.stage.grab(this._resizeStrip);
                this._resizeStrip.add_style_pseudo_class('active');
            }
            return Clutter.EVENT_STOP;
        }
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        if ((type === T.TOUCH_UPDATE || type === T.TOUCH_END || type === T.TOUCH_CANCEL) &&
            (event.get_event_sequence()?.get_slot() ?? -1) !== this._resizeSlot)
            return Clutter.EVENT_STOP;
        const done = type === T.BUTTON_RELEASE || type === T.TOUCH_END || type === T.TOUCH_CANCEL;
        if (type === T.MOTION || type === T.TOUCH_UPDATE || done) {
            const [x, y] = event.get_coords();
            if (this._moveStart) {
                const [x0, y0, left, top] = this._moveStart;
                this._floating.moveTo(left + x - x0, top + y - y0, done);
            } else if (type !== T.TOUCH_CANCEL) {
                this._resizeTo(y);
            }
        }
        if (done)
            this._endResize();
        return Clutter.EVENT_STOP;
    }

    _resizeTo(y) {
        const monitor = Main.layoutManager.keyboardMonitor;
        if (!monitor)
            return;
        // The keyboard sits on the bottom edge, so the finger marks its top.
        const height = monitor.y + monitor.height - y - this.extraHeight;
        const percent = Math.clamp(Math.round(height * 100 / monitor.height), 15, 60);
        const key = monitor.width > monitor.height ? 'height-landscape' : 'height-portrait';
        if (this._settings.get_int(key) !== percent)
            this._settings.set_int(key, percent);
    }

    _endResize() {
        this._dragging = false;
        this._resizeGrab?.dismiss();
        this._resizeGrab = null;
        this._resizeSlot = null;
        this._resizeStrip?.remove_style_pseudo_class('active');
    }

    // ---- toolbar ---------------------------------------------------------

    _buildToolbar() {
        const kb = this._kb;
        this._toolbar = new St.BoxLayout({style_class: 'nkb-toolbar', x_expand: true});

        this._micButton = new St.Button({
            style_class: 'nkb-tool-button nkb-mic',
            can_focus: false,
            accessible_name: 'Dictate',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const micBox = new St.BoxLayout({style_class: 'nkb-mic-box'});
        this._micIcon = new St.Icon({icon_name: 'audio-input-microphone-symbolic'});
        this._micLabel = new St.Label({style_class: 'nkb-mic-label', y_align: Clutter.ActorAlign.CENTER});
        micBox.add_child(this._micIcon);
        micBox.add_child(this._micLabel);
        this._micButton.child = micBox;
        connectTap(this._micButton, {
            onTap: () => this._toggleDictation(),
            onLongPress: () => this.openPanel('language', 'speech'),
        });
        this._toolbar.add_child(this._micButton);

        this._langButton = iconButton('preferences-desktop-locale-symbolic', {
            accessibleName: 'Languages',
            onTap: () => this.togglePanel('language', 'layouts'),
        });
        this._toolbar.add_child(this._langButton);

        this._center = new St.BoxLayout({
            style_class: 'nkb-center',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._suggestionBox = new St.BoxLayout({
            style_class: 'nkb-suggestions',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._statusLabel = new St.Label({
            style_class: 'nkb-toolbar-status',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._center.add_child(this._suggestionBox);
        this._center.add_child(this._statusLabel);
        this._toolbar.add_child(this._center);

        // Emoji live on the keyboard's own emoji key (see extension.js).
        this._editButton = iconButton('edit-select-all-symbolic', {
            accessibleName: 'Text editing',
            onTap: () => this.togglePanel('edit'),
        });
        this._clipboardButton = iconButton('edit-paste-symbolic', {
            accessibleName: 'Clipboard history',
            onTap: () => this.togglePanel('clipboard'),
        });
        this._screenshotButton = iconButton('camera-photo-symbolic', {
            accessibleName: 'Take a screenshot or screen recording',
            onTap: () => this._openScreenshotUi(),
        });
        this._gifButton = labelButton('GIF', {
            styleClass: 'nkb-gif-button',
            onTap: () => this.togglePanel('gif'),
        });
        this._stickerButton = iconButton('image-x-generic-symbolic', {
            accessibleName: 'Stickers',
            onTap: () => this.togglePanel('sticker'),
        });
        // Hold for the keyboard shapes (one-handed, split, floating).
        this._settingsButton = iconButton('emblem-system-symbolic', {
            accessibleName: 'NextKeyBor settings',
            onTap: () => this._openPreferences(),
            onLongPress: () => this.togglePanel('layout'),
        });
        // Floating only: docked, the keyboard's own hide key does this.
        this._closeButton = iconButton('window-close-symbolic', {
            accessibleName: 'Close keyboard',
            onTap: () => this._kb.close(true),
        });
        for (const b of [this._editButton, this._clipboardButton, this._screenshotButton, this._gifButton, this._stickerButton, this._settingsButton, this._closeButton])
            this._toolbar.add_child(b);

        kb.insert_child_at_index(this._toolbar, 0);

        // The stock suggestions row is only used by IBus engines; keep it out
        // of the way unless it has something to show.
        if (kb._suggestions) {
            const sync = () => {
                kb._suggestions.visible = kb._suggestions.get_n_children() > 0 && !this._panel;
            };
            this._syncStockSuggestions = sync;
            kb._suggestions.connectObject(
                'child-added', sync, 'child-removed', sync, this);
            sync();
        }
    }

    _syncVisibility() {
        const available = this._daemon.available;
        const password = this._isPassword();
        for (const b of [this._micButton, this._gifButton, this._stickerButton]) {
            b.reactive = available;
            b.opacity = available ? 255 : 100;
        }
        this._micButton.visible = !password;
        this._closeButton.visible = !!this._floating?.enabled;
        this._clipboardButton.visible = this._settings.get_boolean('clipboard-history');
        // Openverse (used until a GIPHY/KLIPY key is set) has no stickers.
        const provider = this._settings.get_string('gif-provider');
        this._stickerButton.visible = provider !== 'openverse' &&
            this._settings.get_string(`${provider}-api-key`).length > 0;
        this._suggestionBox.visible = available && !password && !this._panel &&
            this._settings.get_boolean('suggestions-enabled');
        if (!this._suggestionBox.visible)
            this._suggestionBox.destroy_all_children();
    }

    _syncMicLabel() {
        const lang = this._settings.get_string('speech-language');
        this._micLabel.text = lang === 'auto' ? '' : lang.toUpperCase();
        this._micLabel.visible = lang !== 'auto';
    }

    _showToolbarStatus(text) {
        this._statusLabel.text = text ?? '';
        this._statusLabel.visible = !!text;
        this._suggestionBox.visible = !text && this._daemon.available && !this._isPassword() &&
            !this._panel && this._settings.get_boolean('suggestions-enabled');
    }

    // ---- panels ----------------------------------------------------------

    _buildPanelHost() {
        this._panelHost = new St.Bin({
            style_class: 'nkb-panel-host',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            visible: false,
        });
        this._kb.insert_child_above(this._panelHost, this._toolbar);
    }

    togglePanel(name, tab) {
        if (this._panelName === name)
            this.closePanel();
        else
            this.openPanel(name, tab);
    }

    openPanel(name, tab) {
        this.closePanel();
        let panel;
        if (name === 'emoji') {
            panel = new EmojiPanel(this._daemon, {
                commit: str => this._commitToApp(str),
                sections: this._kb._emojiSelection?._sections ?? [],
            });
        } else if (name === 'gif' || name === 'sticker') {
            panel = new MediaPanel(this._daemon, this._settings, {
                kind: name,
                paste: item => this._pasteMedia(item),
                openPreferences: this._openPreferences,
            });
        } else if (name === 'language') {
            panel = new LanguagePanel(this._daemon, this._settings);
        } else if (name === 'clipboard') {
            panel = new ClipboardPanel(this._clipboard, {paste: text => this._commitToApp(text)});
        } else if (name === 'edit') {
            panel = new EditPanel({edit: (action, select) => this._editText(action, select)});
        } else if (name === 'layout') {
            panel = new LayoutPanel(this._settings);
        } else {
            return;
        }
        if (tab)
            panel.setTab(tab);
        this._panel = panel;
        this._panelName = name;
        panel.connect('close-request', () => this.closePanel());
        panel.connect('expanded-changed', () => this._layoutPanel());
        this._panelHost.child = panel;
        this._panelHost.show();

        setChecked(this._gifButton, name === 'gif');
        setChecked(this._stickerButton, name === 'sticker');
        setChecked(this._langButton, name === 'language');
        setChecked(this._clipboardButton, name === 'clipboard');
        setChecked(this._editButton, name === 'edit');
        setChecked(this._settingsButton, name === 'layout');
        this._syncVisibility();
        this._syncStockSuggestions?.();
        this._layoutPanel();
    }

    closePanel() {
        if (!this._panel)
            return;
        const panel = this._panel;
        this._panel = null;
        this._panelName = null;
        this._capDeleteDown = false;
        this._panelHost.child = null;
        panel.destroy();
        this._panelHost.hide();
        this._syncStockSuggestions?.();
        for (const b of [this._gifButton, this._stickerButton, this._langButton, this._clipboardButton, this._editButton, this._settingsButton])
            setChecked(b, false);
        this._kb._aspectContainer?.show();
        this._setExtraHeight(0);
        this._syncVisibility();
        this._scheduleSuggest(0);
    }

    _layoutPanel() {
        const panel = this._panel;
        if (!panel || this._layingOut)
            return;
        this._layingOut = true;
        try {
            this._layoutPanelNow(panel);
        } finally {
            this._layingOut = false;
        }
    }

    _layoutPanelNow(panel) {
        // Pin the width: otherwise the panel takes its content's natural
        // width and the GIF grid never wraps (one row, thousands of px wide).
        const padding = this._panelHost.get_stage()
            ? this._panelHost.get_theme_node().get_horizontal_padding() : 0;
        panel.width = Math.max(0, this._kb.width - padding);
        const base = this._kb._nkbBaseHeight || this._kb.height;
        if (panel.expanded) {
            // The panel takes the keys' place; the keyboard keeps its height.
            this._kb._aspectContainer?.hide();
            this._panelHost.y_expand = true;
            this._panelHost.height = -1;
            this._setExtraHeight(0);
        } else {
            this._kb._aspectContainer?.show();
            this._panelHost.y_expand = false;
            // Only the room left under the height cap: a taller strip would
            // push the keys off the bottom of the screen.
            const monitor = Main.layoutManager.keyboardMonitor;
            const room = monitor ? monitor.height * MAX_HEIGHT_RATIO - base : Infinity;
            const strip = Math.max(0, Math.round(Math.min(base * STRIP_RATIO, room)));
            this._panelHost.height = strip;
            this._setExtraHeight(strip);
        }
    }

    _setExtraHeight(extra) {
        if (this.extraHeight === extra)
            return;
        this.extraHeight = extra;
        this._kb._relayout();
    }

    // ---- controller hooks (captured typing + text tracking) ---------------

    _hookController() {
        const ctrl = this._kb._keyboardController;
        this._ctrl = ctrl;
        this._orig = {
            commit: ctrl.commit,
            toggleDelete: ctrl.toggleDelete,
            keyvalPress: ctrl.keyvalPress,
            keyvalRelease: ctrl.keyvalRelease,
            setOskCompletion: ctrl.setOskCompletion,
        };

        // With OSK completion on, GNOME switches IBus to typing-booster, which
        // holds the current word as preedit. That fights our suggestions
        // (they replace text the app has, not the preedit), so keep it off
        // while ours are enabled.
        ctrl.setOskCompletion = enabled => this._orig.setOskCompletion.call(ctrl,
            enabled && !this._settings.get_boolean('suggestions-enabled'));
        ctrl.setOskCompletion(Main.keyboard.visible)
            .catch(e => console.error(`NextKeyBor: OSK completion: ${e}`));

        ctrl.commit = (str, modifiers) => {
            if (this._panel?.capturesTyping) {
                this._panel.typeText(str);
                return Promise.resolve();
            }
            const plain = !modifiers || modifiers.size === 0;
            this._kb._nkbLastCommit = plain ? str : null;
            this._corrected = null;
            const autoSpace = this._autoSpace;
            this._autoSpace = false;
            if (plain && autoSpace && SPACE_BEFORE.test(str) && / $/.test(this._context())) {
                this._settleSwipe();
                this._replaceBeforeCursor(1, `${str} `);
                return Promise.resolve();
            }
            // Double-tap space after a word: replace the first space with ". ".
            if (plain && str === ' ' && this._isDoubleSpace()) {
                this._settleSwipe();
                this._replaceBeforeCursor(1, '. ');
                return Promise.resolve();
            }
            if (plain && AUTOCORRECT_TRIGGER.test(str) && this._applyAutocorrect(str))
                return Promise.resolve();
            this._settleSwipe();
            const promise = this._orig.commit.call(ctrl, str, modifiers);
            if (plain)
                this._onTextCommitted(str);
            else
                this._resetText();
            return promise;
        };

        ctrl.toggleDelete = enabled => {
            // The backspace key's own tap at the end of a backspace swipe.
            if (GLib.get_monotonic_time() < this._ignoreDeleteUntil)
                return;
            if (this._panel?.capturesTyping) {
                if (enabled && !this._capDeleteDown)
                    this._panel.backspace();
                this._capDeleteDown = enabled;
                return;
            }
            const wasEnabled = ctrl._deleteEnabled;
            this._kb._nkbLastCommit = null;
            this._autoSpace = false;
            // Backspace right after a correction puts back what was typed.
            if (enabled && !wasEnabled && this._corrected) {
                ctrl._deleteEnabled = true;
                this._deleteHandled = true;
                this._revertCorrection(true);
                return;
            }
            if (enabled)
                this._corrected = null;
            // Backspace right after a swipe removes the whole swiped word.
            if (enabled && !wasEnabled && this._swipeResult) {
                ctrl._deleteEnabled = true;
                this._deleteHandled = true;
                this._undoSwipe();
                return;
            }
            if (!enabled && this._deleteHandled) {
                this._deleteHandled = false;
                ctrl._deleteEnabled = false;
                return;
            }
            // The stock tap handler enables and disables delete in one go,
            // and apps reporting no surrounding text (terminals, Chromium)
            // then never get the deletion it waits for. Send a real
            // Backspace for them, as the stock code does for terminals.
            if (enabled && !wasEnabled &&
                (this._isTerminal() || !Main.inputMethod.getSurroundingText()[0])) {
                ctrl._deleteEnabled = true;
                ctrl._timesDeleted = 0;
                this._orig.keyvalPress.call(ctrl, Clutter.KEY_BackSpace);
                ctrl._backspacePressed = true;
            } else {
                this._orig.toggleDelete.call(ctrl, enabled);
            }
            if (enabled && !wasEnabled) {
                this._deletePressTime = GLib.get_monotonic_time();
                this._onDeleted();
            } else if (!enabled && wasEnabled) {
                // A held backspace deletes an unknown amount of text.
                const heldMs = (GLib.get_monotonic_time() - this._deletePressTime) / 1000;
                if (heldMs > LONG_DELETE_MS)
                    this._buffer = '';
                this._scheduleSuggest(SUGGEST_DELAY_MS);
            }
        };

        ctrl.keyvalPress = keyval => {
            if (this._panel?.capturesTyping && keyval === Clutter.KEY_Return) {
                this._swallowRelease = true;
                this._panel.enter();
                return;
            }
            this._settleSwipe();
            this._corrected = null;
            this._kb._nkbLastCommit = null;
            this._autoSpace = false;
            this._orig.keyvalPress.call(ctrl, keyval);
            if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter)
                this._onTextCommitted('\n');
        };

        ctrl.keyvalRelease = keyval => {
            if (this._swallowRelease && keyval === Clutter.KEY_Return) {
                this._swallowRelease = false;
                return;
            }
            this._orig.keyvalRelease.call(ctrl, keyval);
        };
    }

    _unhookController() {
        const ctrl = this._ctrl;
        if (!ctrl)
            return;
        for (const name of Object.keys(this._orig)) {
            if (Object.prototype.hasOwnProperty.call(ctrl, name))
                delete ctrl[name];
        }
        ctrl.setOskCompletion(Main.keyboard.visible)
            .catch(e => console.error(`NextKeyBor: OSK completion: ${e}`));
        this._ctrl = null;
    }

    // Press and release keys one at a time from a queue, so a replacement
    // word typed after Backspaces stays in order. An entry is a keyval or
    // {keyval, modifiers} for a shortcut such as Ctrl+C. With GNOME's Bounce
    // Keys on (Accessibility > Typing), a key repeated within its delay is
    // ignored, so repeats wait that long.
    _pressKeys(keyvals) {
        this._keyQueue.push(...keyvals);
        if (!this._keyQueueId)
            this._drainKeys();
    }

    _drainKeys(previous = null) {
        const entry = this._keyQueue.shift();
        if (entry === undefined || !this._ctrl) {
            this._keyQueueId = 0;
            return;
        }
        const {keyval, modifiers = []} = typeof entry === 'number' ? {keyval: entry} : entry;
        const wait = keyval === previous && this._a11yKeyboard.get_boolean('bouncekeys-enable')
            ? this._a11yKeyboard.get_int('bouncekeys-delay') + BOUNCE_MARGIN_MS : 0;
        const press = () => {
            // Real timestamps: the stock keyvalPress uses the current event's
            // time, which is 0 outside an input handler.
            const device = this._ctrl._virtualDevice;
            const send = (k, state) => device.notify_keyval(GLib.get_monotonic_time(), k, state);
            for (const m of modifiers)
                send(m, Clutter.KeyState.PRESSED);
            send(keyval, Clutter.KeyState.PRESSED);
            send(keyval, Clutter.KeyState.RELEASED);
            for (const m of [...modifiers].reverse())
                send(m, Clutter.KeyState.RELEASED);
            this._keyQueueId = GLib.timeout_add(GLib.PRIORITY_HIGH, KEY_GAP_MS, () => {
                this._drainKeys(keyval);
                return GLib.SOURCE_REMOVE;
            });
        };
        if (wait > 0) {
            this._keyQueueId = GLib.timeout_add(GLib.PRIORITY_HIGH, wait, () => {
                press();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            press();
        }
    }

    // An action from the text-editing panel (lib/editPanel.js), as keys.
    _editText(action, select) {
        const K = Clutter;
        const ctrl = K.KEY_Control_L, shift = K.KEY_Shift_L;
        // Terminals copy and paste with Ctrl+Shift.
        const clip = this._isTerminal() ? [ctrl, shift] : [ctrl];
        const moves = {left: K.KEY_Left, right: K.KEY_Right, up: K.KEY_Up, down: K.KEY_Down, home: K.KEY_Home, end: K.KEY_End};
        const shortcuts = {
            selectAll: [[ctrl], K.KEY_a],
            cut: [clip, K.KEY_x],
            copy: [clip, K.KEY_c],
            paste: [clip, K.KEY_v],
            undo: [[ctrl], K.KEY_z],
            redo: [[ctrl, shift], K.KEY_z],
            backspace: [[], K.KEY_BackSpace],
        };
        let entry;
        if (moves[action])
            entry = {keyval: moves[action], modifiers: select ? [shift] : []};
        else if (shortcuts[action])
            entry = {keyval: shortcuts[action][1], modifiers: shortcuts[action][0]};
        else
            return;
        // The text and cursor are no longer what we tracked.
        this._resetText();
        this._pressKeys([entry]);
    }

    _isDoubleSpace() {
        if (!this._settings.get_boolean('double-space-period') ||
            this._isTerminal() || this._isPassword())
            return false;
        const sinceMs = (GLib.get_monotonic_time() - this._lastCommitTime) / 1000;
        return sinceMs < DOUBLE_SPACE_MS && /[\p{L}\p{N})"'”’] $/u.test(this._context());
    }

    // Commit into the focused app regardless of captured typing.
    _commitToApp(str) {
        const promise = this._orig.commit.call(this._ctrl, str, null);
        this._onTextCommitted(str);
        return promise.catch(e => console.error(`NextKeyBor: commit failed: ${e}`));
    }

    _isPassword() {
        const purpose = this._ctrl?.purpose;
        const hints = Main.inputMethod.content_hints ?? 0;
        return purpose === Clutter.InputContentPurpose.PASSWORD ||
            (hints & Clutter.InputContentHintFlags.SENSITIVE_DATA) !== 0;
    }

    _isTerminal() {
        if (this._ctrl?.purpose === Clutter.InputContentPurpose.TERMINAL)
            return true;
        const wmClass = global.display.focus_window?.get_wm_class() ?? '';
        return TERMINAL_WM_CLASS.test(wmClass);
    }

    // ---- text tracking ----------------------------------------------------

    _surroundingFresh() {
        const [text] = Main.inputMethod.getSurroundingText();
        return !!text && !this._isTerminal() &&
            this._lastSurroundingTime >= this._lastCommitTime;
    }

    _context() {
        if (this._surroundingFresh()) {
            const [text, cursor] = Main.inputMethod.getSurroundingText();
            const before = GLib.utf8_substring(text, 0, cursor);
            return before.slice(-MAX_BUFFER);
        }
        return this._buffer;
    }

    _resetText() {
        this._settleSwipe();
        this._swipeRetype = null;
        this._autocorrect = null;
        this._corrected = null;
        this._keepWord = '';
        this._autoSpace = false;
        this._flushLearn();
        this._buffer = '';
        this._lastCommitTime = GLib.get_monotonic_time();
        this._suggestionBox.destroy_all_children();
    }

    _onTextCommitted(str) {
        this._lastCommitTime = GLib.get_monotonic_time();
        // The first word finished after an undone swipe is what it meant.
        if (this._swipeRetype && /^[\s.,!?;:]/u.test(str)) {
            const word = lastWord(this._buffer);
            if (word)
                this._logSwipe(this._swipeRetype, word, 'retyped');
            this._swipeRetype = null;
        }
        this._buffer = (this._buffer + str).slice(-MAX_BUFFER);
        if (!this._isPassword() && this._settings.get_boolean('learn-words')) {
            this._pendingLearn += str;
            const words = this._pendingLearn.trim().split(/\s+/).length;
            if (/[.!?\n]\s*$/.test(this._pendingLearn) ||
                (/\s$/.test(this._pendingLearn) && words >= LEARN_WORD_BATCH))
                this._flushLearn();
        }
        this._refreshAutocorrect();
        this._scheduleSuggest(SUGGEST_DELAY_MS);
    }

    _onDeleted() {
        this._lastCommitTime = GLib.get_monotonic_time();
        this._buffer = [...this._buffer].slice(0, -1).join('');
        this._pendingLearn = [...this._pendingLearn].slice(0, -1).join('');
        this._refreshAutocorrect();
        this._scheduleSuggest(SUGGEST_DELAY_MS);
    }

    _flushLearn() {
        const text = this._pendingLearn.trim();
        this._pendingLearn = '';
        if (!text || !this._daemon.available || this._isPassword())
            return;
        this._daemon.learnText(text, '').catch(() => {});
    }

    _scheduleSuggest(delay) {
        if (this._suggestId)
            GLib.source_remove(this._suggestId);
        this._suggestId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._suggestId = 0;
            this._updateSuggestions().catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
    }

    async _updateSuggestions() {
        if (!this._suggestionBox.visible || !this._kb?.visible)
            return;
        const serial = ++this._suggestSerial;
        // After a swipe, offer the other words the path could have meant.
        if (this._swipeResult) {
            this._suggestionBox.destroy_all_children();
            for (const word of this._swipeResult.words.slice(1, 1 + MAX_SUGGESTIONS))
                this._addSuggestionButton(word, word, false, () => this._replaceSwipe(word));
            return;
        }
        this._sendKeyLayout();
        const context = this._context();
        const partial = lastWord(context);
        const [words, fix, emoji] = await Promise.all([
            this._daemon.suggest(context, '', MAX_SUGGESTIONS),
            this._fetchAutocorrect(context, partial),
            this._fetchEmoji(context),
        ]);
        if (this._destroyed || serial !== this._suggestSerial)
            return;
        this._setAutocorrect(partial, fix);
        this._suggestionBox.destroy_all_children();
        // Just corrected: offer what was typed, to put it back.
        const corrected = this._corrected;
        if (corrected)
            this._addSuggestionButton(corrected.original, null, false, () => this._revertCorrection(false));
        // What a space will turn the word into comes first, in bold. With
        // autocorrect off, the best completion is bold instead.
        const ac = this._autocorrect;
        let shown = words.map(word => matchCase(word, partial));
        if (ac)
            shown = [ac.fix, ...shown.filter(w => w !== ac.fix)];
        const bold = !!ac || (!this._settings.get_boolean('autocorrect') && !!partial);
        shown.slice(0, MAX_SUGGESTIONS - (corrected ? 1 : 0)).forEach((label, i) => {
            this._addSuggestionButton(label, ac && i === 0 ? null : label, i === 0 && bold,
                () => this._applySuggestion(label));
        });
        if (emoji)
            this._addEmojiSuggestion(emoji);
    }

    // An emoji for the word just finished ("pizza " -> 🍕), or ''.
    _fetchEmoji(context) {
        const word = context.match(FINISHED_WORD)?.[1];
        if (!word || !this._settings.get_boolean('emoji-suggestions') || !this._autocorrectAllowed())
            return Promise.resolve('');
        return this._daemon.emojiForWord(word).catch(() => '');
    }

    // Typed after the word and its space, like any emoji, then a space.
    _addEmojiSuggestion(emoji) {
        const button = new St.Button({
            style_class: 'nkb-suggestion nkb-suggestion-emoji',
            label: emoji,
            can_focus: false,
        });
        connectTap(button, {
            onTap: () => {
                this._commitToApp(`${emoji} `);
                this._autoSpace = true;
                this._daemon.noteEmojiUsed(emoji).catch(() => {});
            },
        });
        this._suggestionBox.add_child(button);
    }

    // Corrections favour slips onto neighbouring keys: tell the daemon where
    // the letters are whenever the layout (or its shape) changes.
    _sendKeyLayout() {
        const layout = letterKeyCentres(this._kb);
        if (!layout)
            return;
        const round = v => Math.round(v * 100) / 100;
        const keys = Object.fromEntries(Object.entries(layout.keys).map(([k, [x, y]]) => [k, [round(x), round(y)]]));
        const json = JSON.stringify(keys);
        if (json === this._sentLayout)
            return;
        this._sentLayout = json;
        this._daemon.setKeyLayout(keys).catch(() => {
            this._sentLayout = '';
        });
    }

    _addSuggestionButton(label, word, best, onTap) {
        const button = new St.Button({
            style_class: `nkb-suggestion${best ? ' nkb-suggestion-best' : ''}`,
            label,
            can_focus: false,
            x_expand: true,
        });
        // Long-press forgets a word (word is null for ones that are not
        // suggestions, such as an undone correction).
        connectTap(button, {
            onTap,
            onLongPress: word ? () => {
                this._daemon.forgetWord(word).catch(() => {});
                button.destroy();
            } : null,
        });
        this._suggestionBox.add_child(button);
    }

    _applySuggestion(word) {
        const partial = lastWord(this._context());
        const space = this._settings.get_boolean('auto-space') ? ' ' : '';
        this._replaceBeforeCursor([...partial].length, word + space);
        this._autoSpace = !!space;
    }

    // ---- autocorrect -------------------------------------------------------

    // Not where words are not prose: passwords, terminals, addresses, numbers.
    _autocorrectAllowed() {
        if (this._isPassword() || this._isTerminal())
            return false;
        const P = Clutter.InputContentPurpose;
        const purpose = this._ctrl?.purpose ?? P.NORMAL;
        return purpose === P.NORMAL || purpose === P.ALPHA;
    }

    // The replacement for the word being typed, or '' (the daemon also
    // expands text shortcuts, with autocorrect on or off).
    _fetchAutocorrect(context, partial) {
        if (!partial || partial === this._keepWord || !this._daemon.available || !this._autocorrectAllowed())
            return Promise.resolve('');
        return this._daemon.autocorrect(context, '').catch(() => '');
    }

    _setAutocorrect(partial, fix) {
        this._autocorrect = fix && partial && partial !== this._keepWord ? {partial, fix} : null;
    }

    // Ask at once after each key (suggestions wait a moment), so the answer
    // is in before the space that finishes the word.
    async _refreshAutocorrect() {
        const serial = ++this._autocorrectSerial;
        const context = this._context();
        const partial = lastWord(context);
        const fix = await this._fetchAutocorrect(context, partial);
        if (!this._destroyed && serial === this._autocorrectSerial)
            this._setAutocorrect(partial, fix);
    }

    // Space or punctuation sep finishes the word: type its correction (and
    // sep) instead, if there is one. Returns whether it did.
    _applyAutocorrect(sep) {
        const ac = this._autocorrect;
        const partial = lastWord(this._context());
        if (!ac || !partial || ac.partial !== partial || !this._autocorrectAllowed())
            return false;
        this._settleSwipe();
        this._autocorrect = null;
        this._replaceBeforeCursor([...partial].length, ac.fix + sep);
        this._corrected = {original: partial, fix: ac.fix, sep};
        return true;
    }

    // Put back the word as typed (keeping the space or punctuation after it
    // unless dropSep), and stop correcting it.
    _revertCorrection(dropSep) {
        const c = this._corrected;
        this._corrected = null;
        if (!c)
            return;
        this._replaceBeforeCursor([...(c.fix + c.sep)].length, c.original + (dropSep ? '' : c.sep));
        this._keepWord = c.original;
        this._autocorrect = null;
        this._daemon.acceptWord(c.original).catch(() => {});
    }

    // Replace the len characters before the cursor with text.
    _replaceBeforeCursor(len, text) {
        // Backspaces go through the input thread and reach the app after a
        // text-input commit sent right now would, so once we fall back to
        // key events, type the text as key events too to keep the order.
        const viaKeys = len > 0 && !this._surroundingFresh();
        if (len > 0) {
            if (viaKeys) {
                this._pressKeys(new Array(len).fill(Clutter.KEY_BackSpace));
            } else {
                Main.inputMethod.delete_surrounding(-len, len);
            }
            this._buffer = [...this._buffer].slice(0, -len).join('');
            this._pendingLearn = [...this._pendingLearn].slice(0, -Math.min(len, [...this._pendingLearn].length)).join('');
        }
        if (!text) {
            this._scheduleSuggest(SUGGEST_DELAY_MS);
        } else if (viaKeys) {
            this._pressKeys([...text].map(ch => Clutter.unicode_to_keysym(ch.codePointAt(0))));
            this._onTextCommitted(text);
        } else {
            this._commitToApp(text);
        }
    }

    // ---- swipe typing -----------------------------------------------------

    async _onSwipe(keys, path, shifted) {
        this._settleSwipe();
        this._corrected = null;
        const context = this._context();
        const words = await this._daemon.swipeWords(context, '',
            JSON.stringify(keys), JSON.stringify(path), SWIPE_CHOICES);
        if (this._destroyed || words.length === 0)
            return;
        const cased = shifted ? words.map(w => w.charAt(0).toUpperCase() + w.slice(1)) : words;
        // Swiped words stand alone: add a space after a word typed just before.
        const lead = context && !/[\s(\[{"'“‘/-]$/u.test(context) ? ' ' : '';
        const space = this._settings.get_boolean('auto-space') ? ' ' : '';
        const text = lead + cased[0] + space;
        // Swiping again after undoing one: that swipe meant this one's word.
        const retry = this._swipeRetype;
        this._swipeRetype = null;
        this._commitToApp(text);
        const log = this._settings.get_boolean('swipe-log') ? {keys, path, context, choices: words} : null;
        this._swipeResult = {text, lead, space, words: cased, picked: false, log, retry};
        this._autoSpace = !!space;
        if (shifted && !this._kb._latched)
            this._kb._setActiveLevel('default');
    }

    _replaceSwipe(word) {
        const r = this._swipeResult;
        if (!r)
            return;
        const text = r.lead + word + r.space;
        this._replaceBeforeCursor([...r.text].length, text);
        this._swipeResult = {...r, text, words: [word, ...r.words.filter(w => w !== word)], picked: true};
        this._autoSpace = !!r.space;
    }

    _undoSwipe() {
        const r = this._swipeResult;
        this._swipeResult = null;
        this._replaceBeforeCursor([...r.text].length - [...r.lead].length, '');
        this._swipeRetype = r.log ?? r.retry;
    }

    // The swiped word stays: log what the swipe meant (setting swipe-log).
    _settleSwipe() {
        const r = this._swipeResult;
        this._swipeResult = null;
        if (!r)
            return;
        const word = r.words[0];
        if (r.log)
            this._logSwipe(r.log, word, r.picked ? 'picked' : 'kept');
        if (r.retry)
            this._logSwipe(r.retry, word, 'reswiped');
    }

    _logSwipe(log, word, how) {
        if (!this._settings.get_boolean('swipe-log') || !this._daemon.available)
            return;
        this._daemon.logSwipe({...log, word, how, time: new Date().toISOString()})
            .catch(e => console.error(`NextKeyBor: swipe log: ${e}`));
    }

    // ---- dictation --------------------------------------------------------

    async _toggleDictation() {
        const d = this._dictation;
        try {
            if (d.state === 'idle') {
                d.state = 'starting';
                this._syncMic();
                d.id = await this._daemon.startDictation(this._settings.get_string('speech-language'));
                if (d.state === 'starting')
                    d.state = 'recording';
            } else if (d.state === 'recording') {
                d.state = 'transcribing';
                await this._daemon.stopDictation(d.id);
            } else if (d.state === 'transcribing') {
                await this._daemon.cancelDictation(d.id);
                d.state = 'idle';
                d.id = null;
            }
        } catch (e) {
            d.state = 'idle';
            d.id = null;
            this._flashStatus(`Dictation failed: ${e.message}`);
        }
        this._syncMic();
    }

    _onDictationState(id, state) {
        const d = this._dictation;
        if (d.id && id !== d.id)
            return;
        d.state = state;
        if (state === 'idle')
            d.id = null;
        this._syncMic();
    }

    _onDictationLevel(level) {
        if (this._dictation.state !== 'recording')
            return;
        this._micIcon.opacity = Math.round(110 + 145 * Math.min(1, level * 3));
    }

    _onDictationResult(id, text) {
        const d = this._dictation;
        if (d.id && id !== d.id)
            return;
        d.state = 'idle';
        d.id = null;
        this._syncMic();
        text = text?.trim();
        if (!text)
            return;
        const context = this._context();
        if (context && !/\s$/.test(context))
            text = ` ${text}`;
        if (Main.inputMethod.currentFocus) {
            Main.inputMethod.commit(text);
            this._onTextCommitted(text);
        } else {
            this._commitToApp(text);
        }
    }

    _onDictationError(id, message) {
        const d = this._dictation;
        if (d.id && id !== d.id)
            return;
        d.state = 'idle';
        d.id = null;
        this._syncMic();
        this._flashStatus(message);
    }

    _syncMic() {
        const state = this._dictation.state;
        const active = state === 'recording' || state === 'starting';
        if (active)
            this._micButton.add_style_class_name('nkb-recording');
        else
            this._micButton.remove_style_class_name('nkb-recording');
        if (state === 'transcribing')
            this._micButton.add_style_class_name('nkb-transcribing');
        else
            this._micButton.remove_style_class_name('nkb-transcribing');
        this._micIcon.opacity = 255;
        this._micIcon.icon_name = state === 'transcribing'
            ? 'content-loading-symbolic' : 'audio-input-microphone-symbolic';
        const lang = this._settings.get_string('speech-language');
        if (active)
            this._showToolbarStatus(`Listening${lang === 'auto' ? '' : ` (${lang})`}… tap 🎤 to finish`);
        else if (state === 'transcribing')
            this._showToolbarStatus('Transcribing…');
        else if (!this._flashId)
            this._showToolbarStatus('');
    }

    _flashStatus(text) {
        this._showToolbarStatus(text);
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
            this._flashId = 0;
            if (!this._destroyed)
                this._syncMic();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- media ------------------------------------------------------------

    async _pasteMedia(item) {
        let {path, mime} = await this._daemon.prepareMedia(item);
        if (!path)
            [, path, mime] = await waitForSignal(this._daemon, 'MediaReady', item.id, MEDIA_READY_TIMEOUT_MS);
        const bytes = await loadBytes(path);
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mime || 'image/gif', bytes);

        // Give the clipboard owner change a moment to reach the client.
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            r();
            return GLib.SOURCE_REMOVE;
        }));
        const ctrl = this._ctrl;
        const press = k => this._orig.keyvalPress.call(ctrl, k);
        const release = k => this._orig.keyvalRelease.call(ctrl, k);
        const shift = this._isTerminal();
        press(Clutter.KEY_Control_L);
        if (shift)
            press(Clutter.KEY_Shift_L);
        press(Clutter.KEY_v);
        release(Clutter.KEY_v);
        if (shift)
            release(Clutter.KEY_Shift_L);
        release(Clutter.KEY_Control_L);
    }
}
