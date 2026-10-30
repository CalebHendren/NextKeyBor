// Keyboard shapes other than the stock full-width block: the split keyboard
// in landscape (setting split-landscape) and one-handed mode (setting
// one-handed).
//
// The stock keys keep a fixed aspect ratio and are centred, so a landscape
// keyboard leaves wide empty margins. Split mode instead puts empty columns
// in the middle of each row (lib/holds.js splitRow), enough that the two
// halves reach the screen edges, under the thumbs.
//
// One-handed mode (as on Gboard) narrows the docked keyboard and keeps it on
// one side of keyboardBox (a horizontal box along the bottom edge); a strip
// on the free side holds "move to the other side" and "back to full size".

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {iconButton} from './widgets.js';

const SPLIT_FILL = 0.97; // of the keyboard's width
const MAX_SPLIT_GAP = 16;
const MIN_SPLIT_ROW = 8; // narrower rows (number pads) are never split
const ONE_HANDED_RATIO = 0.7; // of the screen width

function horizontalPadding(actor) {
    return actor.get_stage() ? actor.get_theme_node().get_horizontal_padding() : 0;
}

// 'left' or 'right' when the docked keyboard is one-handed, else null.
export function oneHandedSide(settings, floating) {
    const side = settings.get_string('one-handed');
    return (side === 'left' || side === 'right') && !floating?.enabled ? side : null;
}

// Width of the one-handed keyboard, or null when it is not one-handed. The
// keys keep their shape and are centred in whatever room they get, so in
// landscape the keyboard is only as wide as its keys.
export function oneHandedWidth(keyboard, monitor, settings, floating) {
    if (!monitor || !oneHandedSide(settings, floating))
        return null;
    let width = monitor.width * ONE_HANDED_RATIO;
    const ratio = keyboard._aspectContainer?._ratio;
    if (ratio && keyboard._nkbKeysHeight)
        width = Math.min(width, ratio * keyboard._nkbKeysHeight + horizontalPadding(keyboard));
    return Math.round(width);
}

// Keys of empty space between the halves of rows `width` keys wide, or 0
// when the keyboard is not split. numberRow: the level has the number row.
export function splitGap(keyboard, settings, floating, width, numberRow) {
    const monitor = Main.layoutManager.keyboardMonitor;
    if (!monitor || monitor.width <= monitor.height || width < MIN_SPLIT_ROW ||
        !settings.get_boolean('split-landscape') || floating?.enabled ||
        oneHandedSide(settings, floating))
        return 0;
    const rows = (keyboard._nkbLetterRows ?? 4) + (numberRow ? 1 : 0);
    // The keys' height from the last allocation, or a guess before there
    // is one (the keyboard rebuilds once it knows; see KeyboardUi).
    const keysHeight = keyboard._nkbKeysHeight || (keyboard._nkbBaseHeight || monitor.height / 3) * 0.75;
    // Keys are square-ish: a column is as wide as a row is tall.
    const columns = (monitor.width - horizontalPadding(keyboard)) * SPLIT_FILL * rows / keysHeight;
    return Math.clamp(Math.floor((columns - width) * 2) / 2, 1, MAX_SPLIT_GAP);
}

// The strip beside a one-handed keyboard. It sits next to the keyboard in
// keyboardBox and slides in and out with it.
export class OneHandedStrip {
    constructor(keyboard, settings, floating) {
        this._kb = keyboard;
        this._settings = settings;
        this._floating = floating;

        this.actor = new St.BoxLayout({
            style_class: 'nkb-one-handed-strip',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.START,
            reactive: true,
            visible: false,
        });
        const buttons = new St.BoxLayout({
            style_class: 'nkb-one-handed-buttons',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._swapButton = iconButton('go-next-symbolic', {
            styleClass: 'nkb-one-handed-button',
            accessibleName: 'Move the keyboard to the other side',
            onTap: () => settings.set_string('one-handed',
                settings.get_string('one-handed') === 'left' ? 'right' : 'left'),
        });
        const fullButton = iconButton('view-fullscreen-symbolic', {
            styleClass: 'nkb-one-handed-button',
            accessibleName: 'Full-width keyboard',
            onTap: () => settings.set_string('one-handed', 'off'),
        });
        buttons.add_child(this._swapButton);
        buttons.add_child(fullButton);
        this.actor.add_child(buttons);

        const box = Main.layoutManager.keyboardBox;
        box.add_child(this.actor);
        // keyboardBox itself sits below the screen; like the keyboard, the
        // strip takes touches where it slides to.
        Main.layoutManager.trackChrome(this.actor);
        this._binding = keyboard.bind_property('translation-y', this.actor, 'translation-y',
            GObject.BindingFlags.SYNC_CREATE);

        // style-changed: a skin or theme change.
        keyboard.connectObject(
            'notify::width', () => this.sync(),
            'notify::height', () => this.sync(),
            'style-changed', () => this.sync(), this);
        settings.connectObject(
            'changed::one-handed', () => this.sync(),
            'changed::floating', () => this.sync(), this);
        this.sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (!this._kb._nkbDestroyed)
            this._kb.disconnectObject(this);
        this._binding?.unbind();
        this._binding = null;
        Main.layoutManager.untrackChrome(this.actor);
        this.actor.destroy();
    }

    sync() {
        const side = oneHandedSide(this._settings, this._floating);
        this.actor.visible = !!side;
        if (!side)
            return;
        const box = Main.layoutManager.keyboardBox;
        // The keyboard on the left: the strip goes after it, on the right.
        if (side === 'left')
            box.set_child_above_sibling(this.actor, this._kb);
        else
            box.set_child_below_sibling(this.actor, this._kb);
        this._swapButton.child.icon_name = side === 'left' ? 'go-next-symbolic' : 'go-previous-symbolic';
        // A fixed size: the keyboard expands, and would share any room left.
        const monitor = Main.layoutManager.keyboardMonitor;
        this.actor.set_size(Math.max(0, (monitor?.width ?? 0) - this._kb.width), this._kb.height);
        // The keyboard's own background, whatever the theme or skin (a
        // skin's background image comes from its stylesheet; see skins.js).
        if (this._kb.get_stage()) {
            const c = this._kb.get_theme_node().get_background_color();
            this.actor.style = `background-color: rgba(${c.red}, ${c.green}, ${c.blue}, ${c.alpha / 255});`;
        }
    }
}
