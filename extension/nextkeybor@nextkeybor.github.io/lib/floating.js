// Floating keyboard and the top bar button.
//
// GNOME keeps the keyboard box just below the monitor and slides the keyboard
// up into view (translation_y = -height). Floating narrows the box and moves
// it so the keyboard shows at a saved spot instead, on top of everything, and
// stops the stock "move the window up" behaviour.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MARGIN = 12; // keep this much of the monitor edge free, in logical px

function keyboardHeight() {
    return Main.keyboard._keyboard?.height || Main.layoutManager.keyboardBox.height;
}

export class Floating {
    constructor(settings) {
        this._settings = settings;
        const lm = Main.layoutManager;
        this._origUpdateBox = lm._updateKeyboardBox;
        const self = this;
        lm._updateKeyboardBox = function (...args) {
            self._origUpdateBox.apply(this, args);
            self.apply();
        };
        lm.keyboardBox.connectObject('notify::height', () => this.apply(), this);
        settings.connectObject('changed', (_s, key) => {
            if (key === 'floating' || key.startsWith('float-')) {
                Main.keyboard._keyboard?._relayout();
                lm._updateKeyboardBox();
            }
        }, this);
        lm._updateKeyboardBox();
    }

    destroy() {
        const lm = Main.layoutManager;
        lm._updateKeyboardBox = this._origUpdateBox;
        lm.keyboardBox.disconnectObject(this);
        this._settings.disconnectObject(this);
        lm.keyboardBox.remove_style_class_name('nkb-floating');
        lm._updateKeyboardBox();
    }

    get enabled() {
        return this._settings.get_boolean('floating');
    }

    // Width of the floating keyboard, or null when docked.
    width(monitor) {
        if (!this.enabled || !monitor)
            return null;
        return Math.round(monitor.width * this._settings.get_int('float-width') / 100);
    }

    // Top-left corner of the floating keyboard within its monitor.
    position() {
        const monitor = Main.layoutManager.keyboardMonitor;
        const box = Main.layoutManager.keyboardBox;
        if (!monitor)
            return [0, 0];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = this.width(monitor) ?? monitor.width;
        const height = keyboardHeight();
        const fx = this._settings.get_double('float-x');
        const fy = this._settings.get_double('float-y');
        // Unset: centred near the bottom.
        let x = fx >= 0 ? fx * monitor.width : (monitor.width - width) / 2;
        let y = fy >= 0 ? fy * monitor.height : monitor.height - height - 4 * MARGIN * scale;
        const margin = MARGIN * scale;
        x = Math.clamp(x, margin, Math.max(margin, monitor.width - width - margin));
        y = Math.clamp(y, margin, Math.max(margin, monitor.height - height - margin));
        return [x, y];
    }

    // Moves the floating keyboard; save stores the spot for next time.
    moveTo(x, y, save) {
        const monitor = Main.layoutManager.keyboardMonitor;
        if (!monitor || !this.enabled)
            return;
        this._override = [x, y];
        this.apply();
        if (save) {
            // apply() stored where the keyboard really went (clamped).
            const [cx, cy] = this._placed;
            this._override = null;
            this._settings.set_double('float-x', cx / monitor.width);
            this._settings.set_double('float-y', cy / monitor.height);
        }
    }

    apply() {
        const lm = Main.layoutManager;
        const box = lm.keyboardBox;
        const monitor = lm.keyboardMonitor;
        if (!monitor)
            return;
        if (!this.enabled) {
            box.remove_style_class_name('nkb-floating');
            return;
        }
        box.add_style_class_name('nkb-floating');
        const width = this.width(monitor);
        if (box.width !== width)
            box.set_size(width, -1);
        // The keyboard's own height: the box's reads 0 while a relayout is
        // pending, which put the keyboard off the top of the screen.
        const height = keyboardHeight();
        let [x, y] = this._override ?? this.position();
        if (this._override) {
            const margin = MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor;
            x = Math.clamp(x, margin, Math.max(margin, monitor.width - width - margin));
            y = Math.clamp(y, margin, Math.max(margin, monitor.height - height - margin));
        }
        // The keyboard is slid up by its height inside the box, so put the
        // box's top edge that far below where the keyboard's top should be.
        // A real position, not a translation: hit testing missed the top of
        // a translated box, and taps there went to the window below.
        box.set_position(monitor.x + x, monitor.y + y + height);
        this._placed = [x, y];
    }
}

// Top bar button: tap to show or hide the keyboard, long-press or right-click
// for the menu (floating, reset position, settings).
export const KeyboardIndicator = GObject.registerClass(
class KeyboardIndicator extends PanelMenu.Button {
    _init(settings, {openPreferences}) {
        super._init(0.5, 'NextKeyBor');
        this._settings = settings;
        // The stock click gesture opens the menu on every press; a tap here
        // toggles the keyboard instead (see vfunc_event).
        this._clickGesture?.set_enabled(false);
        this.add_child(new St.Icon({icon_name: 'input-keyboard-symbolic', style_class: 'system-status-icon'}));

        const floatItem = new PopupMenu.PopupSwitchMenuItem('Floating keyboard', settings.get_boolean('floating'));
        floatItem.connect('toggled', (_i, state) => settings.set_boolean('floating', state));
        settings.connectObject('changed::floating', () =>
            floatItem.setToggleState(settings.get_boolean('floating')), this);
        this.menu.addMenuItem(floatItem);
        this.menu.addAction('Reset keyboard position', () => {
            settings.reset('float-x');
            settings.reset('float-y');
        });
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('NextKeyBor settings', () => openPreferences());
    }

    vfunc_event(event) {
        const type = event.type();
        const tap = type === Clutter.EventType.TOUCH_END ||
            (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_PRIMARY);
        const menu = type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_SECONDARY;
        if (type === Clutter.EventType.TOUCH_BEGIN || type === Clutter.EventType.BUTTON_PRESS) {
            this._pressTime = Date.now();
            return Clutter.EVENT_STOP;
        }
        if (menu || (tap && Date.now() - (this._pressTime ?? 0) > 500)) {
            this.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (tap) {
            toggleKeyboard();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    destroy() {
        this._settings.disconnectObject(this);
        restoreA11y();
        super.destroy();
    }
});

// Set while the accessibility setting is on only because the top bar button
// switched it on. GNOME opens an enabled keyboard on every focused text field
// (lock screen, Wi-Fi password…) even with a physical keyboard attached, so
// switch it off again once the keyboard hides.
let a11yEnabledByUs = null;

function restoreA11y() {
    if (!a11yEnabledByUs)
        return;
    Main.keyboard.disconnectObject(a11yEnabledByUs);
    a11yEnabledByUs.set_boolean('screen-keyboard-enabled', false);
    a11yEnabledByUs = null;
}

function toggleKeyboard() {
    const kb = Main.keyboard;
    if (kb.visible) {
        kb.close();
        return;
    }
    // The keyboard only exists while it is enabled (touch mode or the
    // accessibility setting); switch it on if needed, until it hides.
    const a11y = kb._a11yApplicationsSettings;
    if (!kb._keyboard && a11y && !a11y.get_boolean('screen-keyboard-enabled')) {
        a11y.set_boolean('screen-keyboard-enabled', true);
        a11yEnabledByUs = a11y;
        kb.connectObject('visibility-changed', () => {
            if (!kb.visible)
                restoreA11y();
        }, a11y);
    }
    const open = () => kb.open(Main.layoutManager.primaryIndex);
    if (kb._keyboard) {
        open();
    } else {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            open();
            return GLib.SOURCE_REMOVE;
        });
    }
}
