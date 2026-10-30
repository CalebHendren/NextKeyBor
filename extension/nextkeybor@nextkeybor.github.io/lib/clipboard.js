// Clipboard history: the last few texts copied anywhere, kept in memory only
// (never on disk) and pasted back from a panel. Pinned items stay when newer
// copies push the rest out. The list survives the screen lock (which disables
// the extension) but not logging out. Copies that a password manager marks
// as secret (KeePassXC, KDE) are skipped; most others don't mark them.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {Panel} from './panels.js';
import {connectTap, labelButton} from './widgets.js';

const MAX_ITEMS = 20;
const MAX_CHARS = 20000; // per item
const PREVIEW_CHARS = 200;
const TEXT_MIME = /^(text\/plain|UTF8_STRING$|STRING$|TEXT$)/;
// KeePassXC, KDE and others set this on passwords they copy.
const SECRET_MIME = 'x-kde-passwordManagerHint';

// The items while the screen is locked, for the next ClipboardHistory.
let lockedItems = [];

// Emits 'changed' when items change.
export class ClipboardHistory extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.items = this.enabled ? lockedItems : []; // [{text, pinned}], newest first
        lockedItems = [];
        global.display.get_selection().connectObject('owner-changed',
            (_s, type, source) => this._onOwnerChanged(type, source), this);
        settings.connectObject('changed::clipboard-history', () => {
            if (!this.enabled) {
                this.items = [];
                this.emit('changed');
            }
        }, this);
    }

    get enabled() {
        return this._settings.get_boolean('clipboard-history');
    }

    destroy() {
        global.display.get_selection().disconnectObject(this);
        this._settings.disconnectObject(this);
        if (Main.sessionMode.isLocked && this.enabled)
            lockedItems = this.items;
        this.items = [];
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source || !this.enabled)
            return;
        const mimes = source.get_mimetypes() ?? [];
        if (mimes.includes(SECRET_MIME) || !mimes.some(m => TEXT_MIME.test(m)))
            return;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (text?.trim())
                this._add(text.slice(0, MAX_CHARS));
        });
    }

    _add(text) {
        const old = this.items.find(i => i.text === text);
        this.items = [{text, pinned: old?.pinned ?? false}, ...this.items.filter(i => i !== old)];
        // Drop the oldest unpinned items past the limit.
        for (let i = this.items.length - 1; i >= 0 && this.items.length > MAX_ITEMS; i--) {
            if (!this.items[i].pinned)
                this.items.splice(i, 1);
        }
        this.emit('changed');
    }

    setPinned(item, pinned) {
        item.pinned = pinned;
        this.emit('changed');
    }

    remove(item) {
        this.items = this.items.filter(i => i !== item);
        this.emit('changed');
    }

    // Everything but the pinned items.
    clear() {
        this.items = this.items.filter(i => i.pinned);
        this.emit('changed');
    }
}

// One line of a copied text for the list: whitespace runs as single spaces.
function preview(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

export const ClipboardPanel = GObject.registerClass(
class ClipboardPanel extends Panel {
    // paste(text): types the text into the focused app.
    _init(history, {paste}) {
        super._init({placeholder: 'Search clipboard', styleClass: 'nkb-clipboard-panel'});
        this._history = history;
        this._paste = paste;

        this._extraHeader.add_child(labelButton('Clear', {
            styleClass: 'nkb-flat',
            onTap: () => history.clear(),
        }));

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this.status);
        this._list = new St.BoxLayout({
            style_class: 'nkb-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(this._list);
        this.scrollView.child = box;

        history.connectObject('changed', () => this.refresh(), this);
        this.connect('destroy', () => history.disconnectObject(this));
        this.refresh();
    }

    refresh() {
        this._list.destroy_all_children();
        const q = this.query.trim().toLowerCase();
        const items = this._history.items.filter(i => !q || i.text.toLowerCase().includes(q));
        if (!this._history.enabled)
            this.showStatus('Clipboard history is off (NextKeyBor settings → Typing).');
        else if (!this._history.items.length)
            this.showStatus('Text you copy shows up here, until you log out. Tap to paste; hold to pin.');
        else
            this.showStatus(items.length ? '' : 'Nothing found');
        // Pinned first, each group newest first.
        for (const item of [...items.filter(i => i.pinned), ...items.filter(i => !i.pinned)])
            this._list.add_child(this._row(item));
    }

    _row(item) {
        const row = new St.BoxLayout({style_class: 'nkb-row nkb-clip-row', x_expand: true, reactive: true});
        const label = new St.Label({text: preview(item.text), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        row.add_child(label);
        if (item.pinned)
            row.add_child(new St.Icon({icon_name: 'view-pin-symbolic', style_class: 'nkb-row-icon'}));
        connectTap(row, {
            onTap: () => {
                this._paste(item.text);
                this.emit('close-request');
            },
            onLongPress: () => this._history.setPinned(item, !item.pinned),
        });
        return row;
    }
});
