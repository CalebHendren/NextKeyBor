// Keyboard shape menu, from holding the settings button on the toolbar:
// full width, one-handed on either side, split in landscape, floating.
// Picking one applies it and closes the menu.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {connectTap, iconButton, setChecked} from './widgets.js';

function choice(iconName, label, onTap) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'nkb-edit-key-box',
    });
    box.add_child(new St.Icon({icon_name: iconName, x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: label, style_class: 'nkb-edit-key-label', x_align: Clutter.ActorAlign.CENTER}));
    const button = new St.Button({
        style_class: 'nkb-edit-key',
        child: box,
        accessible_name: label,
        can_focus: false,
        x_expand: true,
        y_expand: true,
    });
    connectTap(button, {onTap});
    return button;
}

export const LayoutPanel = GObject.registerClass({
    Signals: {
        'close-request': {},
        'expanded-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class LayoutPanel extends St.BoxLayout {
    _init(settings) {
        super._init({
            style_class: 'nkb-panel nkb-layout-panel',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        // In place of the keys, like the text-editing panel.
        this.expanded = true;
        this._settings = settings;

        const header = new St.BoxLayout({style_class: 'nkb-panel-header', x_expand: true});
        header.add_child(iconButton('window-close-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Close',
            onTap: () => this.emit('close-request'),
        }));
        header.add_child(new St.Label({
            text: 'Keyboard layout',
            style_class: 'nkb-edit-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(header);

        const row = new St.BoxLayout({style_class: 'nkb-layout-choices', x_expand: true, y_expand: true});
        this.add_child(row);
        const pick = fn => () => {
            fn();
            this.emit('close-request');
        };
        const oneHanded = side => pick(() => {
            settings.set_boolean('floating', false);
            settings.set_string('one-handed', side);
        });
        this._buttons = {
            full: choice('input-keyboard-symbolic', 'Full width', oneHanded('off')),
            left: choice('go-previous-symbolic', 'Left hand', oneHanded('left')),
            right: choice('go-next-symbolic', 'Right hand', oneHanded('right')),
            split: choice('view-dual-symbolic', 'Split', pick(() => {
                const on = !settings.get_boolean('split-landscape');
                settings.set_boolean('split-landscape', on);
                if (on) {
                    settings.set_boolean('floating', false);
                    settings.set_string('one-handed', 'off');
                }
            })),
            floating: choice('focus-windows-symbolic', 'Floating', pick(() =>
                settings.set_boolean('floating', !settings.get_boolean('floating')))),
        };
        for (const button of Object.values(this._buttons))
            row.add_child(button);

        settings.connectObject('changed', () => this._sync(), this);
        this.connect('destroy', () => settings.disconnectObject(this));
        this._sync();
    }

    get capturesTyping() {
        return false;
    }

    setTab() {}

    _sync() {
        const s = this._settings;
        const floating = s.get_boolean('floating');
        const side = s.get_string('one-handed');
        setChecked(this._buttons.full, !floating && side === 'off');
        setChecked(this._buttons.left, !floating && side === 'left');
        setChecked(this._buttons.right, !floating && side === 'right');
        setChecked(this._buttons.split, s.get_boolean('split-landscape'));
        setChecked(this._buttons.floating, floating);
    }
});
