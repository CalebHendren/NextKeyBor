// Phone-keyboard touches on the stock OSK keys:
//
// - key popups: the character shows enlarged above the finger while a key
//   is held, as on iOS and Gboard (setting key-popups);
// - space-bar cursor: sliding along the space bar moves the text cursor
//   instead of typing a space (setting space-cursor);
// - double-tap shift for caps lock (stock GNOME only latches on long-press);
// - a click sound on each key press (setting key-sound; played through
//   GNOME's sound player, so it follows the system's alert sound settings).
//
// Like SwipeTyper, this watches touches from keyboardBox's captured-event,
// so it sees them before the keys do.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CURSOR_START = 0.5; // a space-bar touch moves the cursor after this much travel (in key widths)
const CURSOR_STEP = 0.35; // and then by one character per this much
const DOUBLE_TAP_MS = 350;
const POPUP_WIDTH = 1.3; // popup size, relative to the key
const POPUP_HEIGHT = 1.5;

// The stock Key (a St.BoxLayout) around a key button, or null.
function keyOf(actor) {
    const key = actor?.get_parent();
    return key && key.keyButton === actor && typeof key.cancel === 'function' ? key : null;
}

function isShiftKey(key) {
    const icon = key._icon?.icon_name ?? '';
    return icon === 'osk-shift-symbolic' || icon === 'osk-caps-lock-symbolic';
}

export class KeyGestures {
    // enabled(): false while a panel replaces the keys and the like.
    // moveCursor(keyval): send one Left/Right; cursorMoved(): the drag ended.
    // soundFile: a Gio.File with the click sound.
    constructor(keyboard, {settings, enabled, moveCursor, cursorMoved, soundFile = null}) {
        this._kb = keyboard;
        this._soundFile = soundFile;
        this._settings = settings;
        this._enabled = enabled;
        this._moveCursor = moveCursor;
        this._cursorMoved = cursorMoved;
        this._popup = null;
        this._popupSlot = null;
        this._space = null; // {slot, key, anchor, unit, dragging}
        this._lastShiftTap = 0;
        this._latchId = 0;
        this._eventId = Main.layoutManager.keyboardBox.connect('captured-event',
            (_a, event) => this._onEvent(event));
    }

    destroy() {
        Main.layoutManager.keyboardBox.disconnect(this._eventId);
        if (this._latchId)
            GLib.source_remove(this._latchId);
        this._latchId = 0;
        this.hidePopup();
        this._space = null;
    }

    // Drop the touch being watched, if any (its key is going away).
    reset() {
        this.hidePopup();
        this._space = null;
    }

    _onEvent(event) {
        const T = Clutter.EventType;
        const type = event.type();
        if (type === T.TOUCH_BEGIN || type === T.BUTTON_PRESS)
            this._maybeClick(event);
        if (type !== T.TOUCH_BEGIN && type !== T.TOUCH_UPDATE &&
            type !== T.TOUCH_END && type !== T.TOUCH_CANCEL)
            return Clutter.EVENT_PROPAGATE;
        const slot = event.get_event_sequence()?.get_slot() ?? -1;

        if (type === T.TOUCH_BEGIN) {
            const key = keyOf(global.stage.get_event_actor(event));
            if (!key || !this._kb.contains(key) || !this._enabled())
                return Clutter.EVENT_PROPAGATE;
            const label = key.keyButton.get_label();
            if (label === ' ') {
                if (this._settings.get_boolean('space-cursor'))
                    this._space = {slot, key, anchor: event.get_coords()[0], dragging: false};
            } else if (label && [...label].length === 1 && this._settings.get_boolean('key-popups')) {
                this._showPopup(key, label, slot);
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (this._space?.slot === slot) {
            if (type === T.TOUCH_UPDATE)
                return this._dragSpace(event.get_coords()[0]);
            const dragged = this._space.dragging;
            this._space = null;
            if (dragged)
                this._cursorMoved();
            return Clutter.EVENT_PROPAGATE;
        }

        // A finger sliding off its key is swiping, not pressing.
        if (type === T.TOUCH_UPDATE && slot === this._popupSlot) {
            const [cx, width] = this._popupStart;
            if (Math.abs(event.get_coords()[0] - cx) > width)
                this.hidePopup();
        }
        if (type === T.TOUCH_END || type === T.TOUCH_CANCEL) {
            if (slot === this._popupSlot)
                this.hidePopup();
            if (type === T.TOUCH_END)
                this._onRelease(keyOf(global.stage.get_event_actor(event)));
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- key click ---------------------------------------------------------

    _maybeClick(event) {
        if (!this._soundFile || !this._settings.get_boolean('key-sound'))
            return;
        const key = keyOf(global.stage.get_event_actor(event));
        if (key && this._kb.contains(key) && this._enabled())
            global.display.get_sound_player().play_from_file(this._soundFile, 'Key click', null);
    }

    // ---- key popups --------------------------------------------------------

    _showPopup(key, label, slot) {
        this.hidePopup();
        const [kx, ky] = key.keyButton.get_transformed_position();
        const [kw, kh] = key.keyButton.get_transformed_size();
        if (!kw || !kh)
            return;
        const width = Math.round(kw * POPUP_WIDTH), height = Math.round(kh * POPUP_HEIGHT);
        this._popup = new St.Bin({style_class: 'nkb-key-popup', reactive: false, width, height});
        this._popup.child = new St.Label({
            text: label,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${Math.round(kh * 0.8)}px;`,
        });
        // Above the key, its bottom just over the key's top half.
        const x = Math.clamp(Math.round(kx + (kw - width) / 2), 0, global.stage.width - width);
        this._popup.set_position(x, Math.max(0, Math.round(ky + kh * 0.4 - height)));
        Main.layoutManager.uiGroup.add_child(this._popup);
        this._popupSlot = slot;
        this._popupStart = [kx + kw / 2, kw];
        // The long-press popup (extra characters) takes over from ours.
        this._popupKey = key;
        key.connectObject('long-press', () => this.hidePopup(), this);
    }

    hidePopup() {
        this._popupKey?.disconnectObject(this);
        this._popupKey = null;
        this._popup?.destroy();
        this._popup = null;
        this._popupSlot = null;
    }

    // ---- space-bar cursor --------------------------------------------------

    _dragSpace(x) {
        const s = this._space;
        const unit = this._keyWidth();
        if (!s.dragging) {
            if (Math.abs(x - s.anchor) < CURSOR_START * unit)
                return Clutter.EVENT_PROPAGATE;
            // Undo the press without typing a space, as a swipe does.
            s.dragging = true;
            s.key.cancel();
            s.key._pressed = false;
            s.key.keyButton.remove_style_pseudo_class('active');
            s.key.emit('released');
            s.anchor += Math.sign(x - s.anchor) * CURSOR_START * unit;
        }
        const step = CURSOR_STEP * unit;
        let moves = Math.trunc((x - s.anchor) / step);
        s.anchor += moves * step;
        const keyval = moves < 0 ? Clutter.KEY_Left : Clutter.KEY_Right;
        for (moves = Math.abs(moves); moves > 0; moves--)
            this._moveCursor(keyval);
        return Clutter.EVENT_STOP;
    }

    // Width of a letter key, the unit for drag distances.
    _keyWidth() {
        const key = this._space?.key;
        const [, height] = key?.keyButton.get_transformed_size() ?? [0, 0];
        // The space bar is wide; letter keys are about as wide as it is tall.
        return height || 40;
    }

    // ---- double-tap shift --------------------------------------------------

    _onRelease(key) {
        if (!key || !isShiftKey(key))
            return;
        const now = GLib.get_monotonic_time() / 1000;
        const second = now - this._lastShiftTap < DOUBLE_TAP_MS;
        this._lastShiftTap = second ? 0 : now;
        if (!second)
            return;
        // The second tap first goes to the key, which drops shift again;
        // latch caps lock once it has.
        if (this._latchId)
            GLib.source_remove(this._latchId);
        this._latchId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._latchId = 0;
            if (this._kb?._layers?.['shift']) {
                this._kb._setActiveLevel('shift');
                this._kb._setLatched(true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}
