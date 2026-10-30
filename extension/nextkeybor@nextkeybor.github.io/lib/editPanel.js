// Text-editing panel (as on Gboard): in place of the keys, arrows to move
// the cursor (or the selection, with Select on), Home/End, select all,
// cut/copy/paste, undo/redo and backspace. Arrows and backspace repeat while
// held.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {iconButton, setChecked} from './widgets.js';

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

// A key that runs action on release, or with repeat, on press and then
// every REPEAT_INTERVAL_MS while held.
function editKey(child, accessibleName, action, repeat) {
    const button = new St.Button({
        style_class: 'nkb-edit-key',
        child,
        accessible_name: accessibleName,
        can_focus: false,
        reactive: true,
        x_expand: true,
        y_expand: true,
    });
    let timeoutId = 0;
    let pressed = false;
    let slot = null;
    const stop = fire => {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        timeoutId = 0;
        button.remove_style_pseudo_class('active');
        if (pressed && fire && !repeat)
            action();
        pressed = false;
        slot = null;
    };
    const start = () => {
        stop(false);
        pressed = true;
        button.add_style_pseudo_class('active');
        if (!repeat)
            return;
        action();
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_DELAY_MS, () => {
            action();
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_INTERVAL_MS, () => {
                action();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    };
    button.connect('button-press-event', (_a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        start();
        return Clutter.EVENT_STOP;
    });
    button.connect('button-release-event', () => {
        stop(true);
        return Clutter.EVENT_STOP;
    });
    button.connect('leave-event', () => {
        if (slot === null)
            stop(false);
        return Clutter.EVENT_PROPAGATE;
    });
    button.connect('touch-event', (_a, event) => {
        const type = event.type();
        const s = event.get_event_sequence()?.get_slot();
        if (type === Clutter.EventType.TOUCH_BEGIN && slot === null) {
            start();
            slot = s;
        } else if ((type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) && s === slot) {
            stop(type === Clutter.EventType.TOUCH_END);
        }
        return Clutter.EVENT_STOP;
    });
    button.connect('destroy', () => stop(false));
    return button;
}

function keyContent(iconName, label) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'nkb-edit-key-box',
    });
    box.add_child(new St.Icon({icon_name: iconName, x_align: Clutter.ActorAlign.CENTER}));
    if (label)
        box.add_child(new St.Label({text: label, style_class: 'nkb-edit-key-label', x_align: Clutter.ActorAlign.CENTER}));
    return box;
}

export const EditPanel = GObject.registerClass({
    Signals: {
        'close-request': {},
        'expanded-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class EditPanel extends St.BoxLayout {
    // edit(action, select): one of left, right, up, down, home, end (moving
    // the selection when select is true), selectAll, cut, copy, paste, undo,
    // redo, backspace. In a terminal, selectAll, undo and redo are greyed
    // out: Ctrl+Z would suspend the running job.
    _init({edit, terminal = false}) {
        super._init({
            style_class: 'nkb-panel nkb-edit-panel',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.expanded = true;
        this._edit = edit;
        this._select = false;

        const header = new St.BoxLayout({style_class: 'nkb-panel-header', x_expand: true});
        header.add_child(iconButton('window-close-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Close',
            onTap: () => this.emit('close-request'),
        }));
        header.add_child(new St.Label({
            text: 'Text editing',
            style_class: 'nkb-edit-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(header);

        const grid = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
        const body = new St.Widget({style_class: 'nkb-edit-grid', layout_manager: grid, x_expand: true, y_expand: true});
        grid.set_column_spacing(6);
        grid.set_row_spacing(6);
        this.add_child(body);

        const key = (icon, label, action, col, row, width = 1, height = 1, repeat = false) => {
            const button = editKey(keyContent(icon, label), label || action, () => this._run(action), repeat);
            grid.attach(button, col, row, width, height);
            return button;
        };

        // Left: the cursor pad.
        key('go-first-symbolic', 'Home', 'home', 0, 0);
        key('go-up-symbolic', '', 'up', 1, 0, 1, 1, true);
        key('go-last-symbolic', 'End', 'end', 2, 0);
        key('go-previous-symbolic', '', 'left', 0, 1, 1, 1, true);
        this._selectButton = key('edit-select-symbolic', 'Select', 'select', 1, 1);
        key('go-next-symbolic', '', 'right', 2, 1, 1, 1, true);
        key('go-down-symbolic', '', 'down', 1, 2, 1, 1, true);
        // Right: editing.
        const appOnly = [
            key('edit-select-all-symbolic', 'Select all', 'selectAll', 4, 0),
            key('edit-undo-symbolic', 'Undo', 'undo', 5, 0),
            key('edit-redo-symbolic', 'Redo', 'redo', 6, 0),
        ];
        if (terminal) {
            for (const button of appOnly) {
                button.reactive = false;
                button.opacity = 100;
            }
        }
        key('edit-cut-symbolic', 'Cut', 'cut', 4, 1);
        key('edit-copy-symbolic', 'Copy', 'copy', 5, 1);
        key('edit-paste-symbolic', 'Paste', 'paste', 6, 1);
        key('edit-clear-symbolic', 'Delete', 'backspace', 4, 2, 3, 1, true);
    }

    get capturesTyping() {
        return false;
    }

    setTab() {}

    _run(action) {
        if (action === 'select') {
            this._select = !this._select;
            setChecked(this._selectButton, this._select);
            return;
        }
        const moves = ['left', 'right', 'up', 'down', 'home', 'end'];
        this._edit(action, this._select && moves.includes(action));
        // Done with the selection once something is done to it.
        if (!moves.includes(action) && this._select) {
            this._select = false;
            setChecked(this._selectButton, false);
        }
    }
});
