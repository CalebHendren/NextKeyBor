// NextKeyBor: extends the GNOME Shell on-screen keyboard.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Keyboard} from 'resource:///org/gnome/shell/ui/keyboard.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DaemonClient} from './lib/daemon.js';
import {Floating, KeyboardIndicator} from './lib/floating.js';
import {TapFix, updateLevelFromHints} from './lib/fixes.js';
import {augmentRow, centreSpaceBar, numberRowFor, replaceWwwKey} from './lib/holds.js';
import {KeyboardUi, MAX_HEIGHT_RATIO} from './lib/keyboardUi.js';

// Earlier single-purpose fixes that NextKeyBor includes; running both would
// open the keyboard twice.
const LEGACY_EXTENSIONS = ['osk-tap-fix@surface.local', 'auto-osk-focus@surface.local'];

export default class NextKeyBorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._daemon = new DaemonClient(this.dir);
        this._uis = new Map(); // Keyboard -> KeyboardUi
        this._tapFix = null;

        for (const uuid of LEGACY_EXTENSIONS) {
            if (global.settings.get_strv('enabled-extensions').includes(uuid)) {
                console.log(`NextKeyBor: disabling ${uuid}, which it replaces`);
                Main.extensionManager.disableExtension(uuid);
            }
        }

        this._floating = new Floating(this._settings);
        this._patchKeyboard();
        this._syncIndicator();

        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'chromium-tap-fix')
                this._syncTapFix();
            else if (key === 'hold-for-numbers' || key === 'number-row')
                this._rebuildKeys();
            else if (key === 'height-landscape' || key === 'height-portrait')
                Main.keyboard._keyboard?._relayout();
            else if (key === 'show-indicator')
                this._syncIndicator();
        }, this);
        this._syncTapFix();

        const kb = Main.keyboard._keyboard;
        if (kb) {
            this._inject(kb);
            this._rebuildKeys();
        }
    }

    disable() {
        this._settings.disconnectObject(this);
        this._tapFix?.destroy();
        this._tapFix = null;

        for (const [kb, ui] of this._uis) {
            if (!kb._nkbDestroyed)
                kb.disconnectObject(this);
            ui.destroy();
        }
        this._uis.clear();

        this._indicator?.destroy();
        this._indicator = null;
        this._unpatchKeyboard();
        this._floating.destroy();
        this._floating = null;
        this._rebuildKeys();
        Main.keyboard._keyboard?._relayout();

        this._daemon.destroy();
        this._daemon = null;
        this._settings = null;
        this._uis = null;
    }

    _syncIndicator() {
        const want = this._settings.get_boolean('show-indicator');
        if (want && !this._indicator) {
            this._indicator = new KeyboardIndicator(this._settings, {
                openPreferences: () => this.openPreferences(),
            });
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _syncTapFix() {
        const want = this._settings.get_boolean('chromium-tap-fix');
        if (want && !this._tapFix)
            this._tapFix = new TapFix();
        else if (!want && this._tapFix) {
            this._tapFix.destroy();
            this._tapFix = null;
        }
    }

    _rebuildKeys() {
        try {
            Main.keyboard._keyboard?._updateKeys();
        } catch (e) {
            console.error(`NextKeyBor: rebuilding keys failed: ${e}`);
        }
    }

    _patchKeyboard() {
        const proto = Keyboard.prototype;
        const ext = this;
        const settings = this._settings;
        this._orig = {
            _setupKeyboard: proto._setupKeyboard,
            _relayout: proto._relayout,
            _addRowKeys: proto._addRowKeys,
            _updateLevelFromHints: proto._updateLevelFromHints,
            _toggleEmoji: proto._toggleEmoji,
            setCursorLocation: proto.setCursorLocation,
        };
        const orig = this._orig;

        proto._setupKeyboard = function (...args) {
            orig._setupKeyboard.apply(this, args);
            ext._inject(this);
        };

        proto._relayout = function (...args) {
            // The stock code clamps to the preferred height, which is the
            // fixed height from the last relayout; drop it so our extra height
            // isn't folded into the base and added again on every relayout.
            this.height = -1;
            const [minHeight] = this.get_preferred_height(-1);
            orig._relayout.apply(this, args);
            const monitor = Main.layoutManager.keyboardMonitor;
            if (!monitor)
                return;
            // Floating: narrower than the monitor (see lib/floating.js).
            const floatWidth = ext._floating?.width(monitor);
            if (floatWidth)
                this.width = floatWidth;
            const maxHeight = monitor.height * MAX_HEIGHT_RATIO;
            const key = monitor.width > monitor.height ? 'height-landscape' : 'height-portrait';
            const base = Math.clamp(monitor.height * settings.get_int(key) / 100, minHeight, maxHeight);
            const extra = ext._uis?.get(this)?.extraHeight ?? 0;
            this._nkbBaseHeight = base;
            this.height = Math.min(base + extra, maxHeight);
        };

        // A floating keyboard does not cover the bottom edge, so windows need
        // not move up out of its way.
        proto.setCursorLocation = function (...args) {
            if (ext._floating?.enabled) {
                this._setFocusWindow(null);
                return;
            }
            orig.setCursorLocation.apply(this, args);
        };

        // The emoji key opens NextKeyBor's searchable picker instead.
        proto._toggleEmoji = function (...args) {
            const ui = ext._uis?.get(this);
            if (ui)
                ui.togglePanel('emoji');
            else
                orig._toggleEmoji.apply(this, args);
        };

        proto._addRowKeys = function (keys, layout, ...rest) {
            try {
                centreSpaceBar(keys);
            } catch (e) {
                console.error(`NextKeyBor: space bar layout failed: ${e}`);
            }
            try {
                replaceWwwKey(keys);
            } catch (e) {
                console.error(`NextKeyBor: www. key replacement failed: ${e}`);
            }
            // Rows as the layout file counts them, before any number row.
            let row = layout._nRows - (layout._nkbAddedRows ?? 0);
            if (settings.get_boolean('number-row')) {
                try {
                    const digits = numberRowFor(keys, row, layout.mode);
                    if (digits) {
                        orig._addRowKeys.call(this, digits, layout, ...rest);
                        layout.appendRow();
                        layout._nkbAddedRows = (layout._nkbAddedRows ?? 0) + 1;
                        row = layout._nRows - layout._nkbAddedRows;
                    }
                } catch (e) {
                    console.error(`NextKeyBor: number row failed: ${e}`);
                }
            }
            if (settings.get_boolean('hold-for-numbers')) {
                try {
                    augmentRow(keys, row, layout.mode);
                } catch (e) {
                    console.error(`NextKeyBor: long-press variants failed: ${e}`);
                }
            }
            return orig._addRowKeys.call(this, keys, layout, ...rest);
        };

        proto._updateLevelFromHints = function (...args) {
            // As on Gboard, the ?123 page stays up while typing digits and
            // symbols, and a space goes back to the letters.
            const [userInputHappened] = args;
            const symbols = this._currentPage &&
                (this._currentPage === this._layers?.['opt'] || this._currentPage === this._layers?.['opt+shift']);
            if (userInputHappened && symbols && !this._latched) {
                if (this._nkbLastCommit !== ' ')
                    return undefined;
                this._setActiveLevel('default');
            }
            if (settings.get_boolean('fix-auto-capitalization'))
                return updateLevelFromHints.apply(this, args);
            return orig._updateLevelFromHints.apply(this, args);
        };
    }

    _unpatchKeyboard() {
        const proto = Keyboard.prototype;
        for (const [name, fn] of Object.entries(this._orig ?? {}))
            proto[name] = fn;
        this._orig = null;
    }

    _inject(kb) {
        if (!this._uis || this._uis.has(kb))
            return;
        try {
            const ui = new KeyboardUi(kb, {
                settings: this._settings,
                daemon: this._daemon,
                floating: this._floating,
                openPreferences: () => {
                    kb.close(true);
                    this.openPreferences();
                },
            });
            this._uis.set(kb, ui);
            kb.connectObject('destroy', () => {
                kb._nkbDestroyed = true;
                const u = this._uis?.get(kb);
                if (u) {
                    this._uis.delete(kb);
                    u.destroy();
                }
            }, this);
        } catch (e) {
            console.error(`NextKeyBor: could not extend the on-screen keyboard: ${e}\n${e.stack}`);
        }
    }
}
