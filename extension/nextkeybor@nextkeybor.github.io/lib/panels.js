// Search panels shown above (or instead of) the keys: emoji & symbols, GIFs &
// stickers, and the language menu. While a panel is open the OSK keys type
// into the panel's query instead of the focused app ("captured typing").

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as InputSourceManager from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {AnimatedImage} from './animatedImage.js';
import {connectTap, iconButton, labelButton, setChecked} from './widgets.js';

const SEARCH_DEBOUNCE_MS = 250;
const TOUCH_SCROLL_SLOP = 10;

// Drag-to-scroll for touchscreens: St.ScrollView only scrolls with wheels
// and scrollbars. Children still get their events; connectTap() cancels a tap
// once the finger moved.
function enableTouchScroll(scrollView, horizontal = false) {
    let startCoord = null;
    let startValue = 0;
    let dragging = false;
    const adjustment = () => horizontal
        ? scrollView.hadjustment : scrollView.vadjustment;
    scrollView.connect('captured-event', (_a, event) => {
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            const [x, y] = event.get_coords();
            startCoord = horizontal ? x : y;
            startValue = adjustment().value;
            dragging = false;
        } else if (type === Clutter.EventType.TOUCH_UPDATE && startCoord !== null) {
            const [x, y] = event.get_coords();
            const delta = (horizontal ? x : y) - startCoord;
            if (!dragging && Math.abs(delta) > TOUCH_SCROLL_SLOP)
                dragging = true;
            const adj = adjustment();
            const value = Math.clamp(startValue - delta, adj.lower, Math.max(adj.lower, adj.upper - adj.page_size));
            if (dragging && Number.isFinite(value))
                adj.value = value;
        } else if (type === Clutter.EventType.TOUCH_END ||
                   type === Clutter.EventType.TOUCH_CANCEL) {
            startCoord = null;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}

// After the new content is laid out; set right away, the adjustment still has
// the old range and the view can open part-way down.
function scrollToTop(scrollView) {
    scrollView.vadjustment.value = 0;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        scrollView.vadjustment.value = 0;
        return GLib.SOURCE_REMOVE;
    });
}

// An emoji without variation selectors, for comparing spellings.
function bare(str) {
    return str.replace(/[\uFE0E\uFE0F]/g, '');
}

function flowBox(styleClass) {
    return new St.Widget({
        style_class: styleClass,
        layout_manager: new Clutter.FlowLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_spacing: 6,
            row_spacing: 6,
        }),
        x_expand: true,
    });
}

export const Panel = GObject.registerClass({
    Signals: {
        'close-request': {},
        'expanded-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Panel extends St.BoxLayout {
    _init({placeholder, tabs = [], styleClass = ''}) {
        super._init({
            style_class: `nkb-panel ${styleClass}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.query = '';
        // Full: the panel fills the keyboard and the keys are hidden, for
        // browsing. Tapping the search box brings the keys back to type.
        this.expanded = true;
        this._placeholder = placeholder;
        this._searchTimeoutId = 0;

        const header = new St.BoxLayout({style_class: 'nkb-panel-header', x_expand: true});
        this.add_child(header);
        header.add_child(iconButton('window-close-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Close',
            onTap: () => this.emit('close-request'),
        }));

        this._tabButtons = new Map();
        for (const {id, label, icon} of tabs) {
            const button = icon
                ? iconButton(icon, {styleClass: 'nkb-tab', accessibleName: label, onTap: () => this.setTab(id)})
                : labelButton(label, {styleClass: 'nkb-tab', onTap: () => this.setTab(id)});
            this._tabButtons.set(id, button);
            header.add_child(button);
        }

        const queryBox = new St.BoxLayout({style_class: 'nkb-query', x_align: Clutter.ActorAlign.CENTER});
        queryBox.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'nkb-query-icon'}));
        this._queryLabel = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'nkb-query-label',
        });
        this._queryLabel.clutter_text.ellipsize = 1; // Pango.EllipsizeMode.START
        queryBox.add_child(this._queryLabel);
        this._clearButton = iconButton('edit-clear-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Clear',
            onTap: () => this.setQuery(''),
        });
        queryBox.add_child(this._clearButton);
        // Hides the keys again after searching.
        this._hideKeysButton = iconButton('go-down-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Hide keyboard',
            onTap: () => this.setExpanded(true),
        });
        queryBox.add_child(this._hideKeysButton);
        connectTap(queryBox, {onTap: () => this.setExpanded(false)});
        // Centred in the header rather than stretched across it.
        header.add_child(new St.Bin({child: queryBox, x_expand: true}));

        this._extraHeader = new St.BoxLayout();
        header.add_child(this._extraHeader);


        this.scrollView = new St.ScrollView({
            style_class: 'nkb-panel-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        enableTouchScroll(this.scrollView);
        this.add_child(this.scrollView);

        this.status = new St.Label({style_class: 'nkb-status', visible: false, x_expand: true});
        this.status.clutter_text.line_wrap = true;

        this.connect('destroy', () => this._cancelSearch());
        this._hideKeysButton.visible = !this.expanded;
        this._syncQueryLabel();
    }

    get capturesTyping() {
        return true;
    }

    setExpanded(expanded) {
        if (this.expanded === expanded)
            return;
        this.expanded = expanded;
        this._hideKeysButton.visible = !expanded;
        this.emit('expanded-changed', expanded);
    }

    setTab(id) {
        this.tab = id;
        for (const [tabId, button] of this._tabButtons)
            setChecked(button, tabId === id);
        this.refresh();
    }

    setQuery(query) {
        if (query === this.query)
            return;
        this.query = query;
        this._syncQueryLabel();
        this._cancelSearch();
        this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
            this._searchTimeoutId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearch() {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
    }

    _syncQueryLabel() {
        if (this.query) {
            this._queryLabel.text = this.query;
            this._queryLabel.remove_style_class_name('nkb-placeholder');
        } else {
            this._queryLabel.text = this._placeholder;
            this._queryLabel.add_style_class_name('nkb-placeholder');
        }
        this._clearButton.visible = this.query.length > 0;
    }

    // Captured typing
    typeText(str) {
        if (str === '\n')
            return;
        this.setQuery(this.query + str);
    }

    backspace() {
        if (this.query)
            this.setQuery([...this.query].slice(0, -1).join(''));
    }

    enter() {
        this._cancelSearch();
        this.refresh();
    }

    showStatus(text) {
        this.status.text = text ?? '';
        this.status.visible = !!text;
    }

    refresh() {}
});

// ---------------------------------------------------------------------------

export const EmojiPanel = GObject.registerClass(
class EmojiPanel extends Panel {
    // sections: the stock keyboard's emoji categories ({label, keys: [{label,
    // variants}]}), parsed by GNOME Shell from its own emoji.json.
    _init(daemon, {commit, sections = []}) {
        super._init({
            placeholder: 'Search emoji',
            styleClass: 'nkb-emoji-panel',
            tabs: [
                {id: 'emoji', label: 'Emoji', icon: 'face-smile-symbolic'},
                {id: 'symbols', label: 'Ω'},
            ],
        });
        this._daemon = daemon;
        this._commit = commit;
        this._serial = 0;
        this._sections = sections.filter(s => s.keys?.length);
        // Search and recents come from CLDR data, which also names plain
        // symbols; keep only what GNOME lists as emoji.
        this._known = new Set();
        for (const s of this._sections) {
            for (const k of s.keys) {
                this._known.add(bare(k.label));
                for (const v of k.variants ?? [])
                    this._known.add(bare(v));
            }
        }
        this._category = 'recent';

        this._categoryBar = new St.BoxLayout({style_class: 'nkb-category-bar', x_align: Clutter.ActorAlign.CENTER});
        this._categoryButtons = new Map();
        const addCategory = (id, child, name) => {
            const button = new St.Button({style_class: 'nkb-category', can_focus: false, accessible_name: name});
            button.child = child;
            connectTap(button, {onTap: () => this._showCategory(id)});
            this._categoryButtons.set(id, button);
            this._categoryBar.add_child(button);
        };
        addCategory('recent', new St.Icon({icon_name: 'document-open-recent-symbolic'}), 'Recent');
        this._sections.forEach((s, i) => addCategory(i, new St.Label({text: s.label}), s.label));
        this.insert_child_above(this._categoryBar, this.get_first_child());

        this._variantBar = new St.BoxLayout({style_class: 'nkb-variant-bar', x_align: Clutter.ActorAlign.CENTER, visible: false});
        this.insert_child_above(this._variantBar, this._categoryBar);

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this.status);
        // Explicit rows, not a FlowLayout: in a short panel the flow layout
        // squeezed its rows to zero height and the emoji vanished.
        this._grid = new St.BoxLayout({
            style_class: 'nkb-emoji-grid',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._grid);
        this.scrollView.child = box;
        this.setTab('emoji');
    }

    _showCategory(id) {
        this._category = id;
        if (this.query)
            this.setQuery(''); // refreshes
        else
            this.refresh();
    }

    async refresh() {
        const serial = ++this._serial;
        const symbols = this.tab === 'symbols';
        this._placeholder = symbols ? 'Search symbols (arrow, euro, degree…)' : 'Search emoji';
        this._syncQueryLabel();
        this._variantBar.hide();
        this._categoryBar.visible = !symbols;
        for (const [id, button] of this._categoryButtons)
            setChecked(button, !this.query && id === this._category);

        let items; // [{char, name, variants}]
        if (!symbols && !this.query && this._category !== 'recent') {
            items = (this._sections[this._category]?.keys ?? [])
                .map(k => ({char: k.label, name: '', variants: k.variants ?? []}));
        } else {
            let results;
            try {
                results = symbols
                    ? await this._daemon.searchSymbols(this.query, 120)
                    : await this._daemon.searchEmoji(this.query, 120);
            } catch (e) {
                if (serial === this._serial)
                    this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
                return;
            }
            items = results
                .map(r => ({char: symbols ? r.symbol : r.emoji, name: r.name ?? '', variants: []}))
                .filter(i => i.char && (symbols || this._known.size === 0 || this._known.has(bare(i.char))));
        }
        if (serial !== this._serial)
            return;
        // Nothing used yet: start on the first category instead of a blank grid.
        if (!items.length && !symbols && !this.query && this._category === 'recent' && this._sections.length) {
            this._showCategory(0);
            return;
        }
        this.showStatus(items.length ? '' : 'Nothing found');
        this._items = {items, symbols};
        this._fillGrid();
        scrollToTop(this.scrollView);
    }

    // Lays the current items out in rows that fit the panel's width.
    _fillGrid() {
        const {items = [], symbols = false} = this._items ?? {};
        this._grid.destroy_all_children();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = this.width > 0 ? this.width : global.stage.width;
        const columns = Math.max(1, Math.floor((width - 16 * scale) / (EMOJI_CELL * scale)));
        let row = null;
        items.forEach((item, i) => {
            if (i % columns === 0) {
                row = new St.BoxLayout({style_class: 'nkb-emoji-row'});
                this._grid.add_child(row);
            }
            row.add_child(this._emojiButton(item, symbols));
        });
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        // Re-flow when the panel's width changes (rotation, resize).
        const width = Math.round(box.get_width());
        if (width !== this._flowWidth && this._items) {
            this._flowWidth = width;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._fillGrid();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _emojiButton({char, name, variants}, symbols) {
        const button = new St.Button({
            style_class: `nkb-emoji ${symbols ? 'nkb-symbol' : ''}`,
            label: char,
            accessible_name: name || char,
            can_focus: false,
        });
        connectTap(button, {
            onTap: () => this._pick(char, symbols),
            // Skin tones and other variants, else the name.
            onLongPress: () => variants.length > 1
                ? this._showVariants(variants)
                : this.showStatus(`${char}  ${name}`),
        });
        return button;
    }

    _showVariants(variants) {
        this._variantBar.destroy_all_children();
        for (const v of variants) {
            const button = new St.Button({style_class: 'nkb-emoji', label: v, can_focus: false});
            connectTap(button, {onTap: () => this._pick(v, false)});
            this._variantBar.add_child(button);
        }
        this._variantBar.show();
    }

    _pick(char, symbols) {
        this._commit(char);
        if (!symbols)
            this._daemon.noteEmojiUsed(char).catch(() => {});
    }
});

// ---------------------------------------------------------------------------

const PAGE_LOAD_MARGIN = 240;
// An emoji button (46px, see .nkb-emoji) plus the row spacing.
const EMOJI_CELL = 50;
const MEDIA_TILE_RATIO = 1.3; // tile width / height
const MEDIA_SPACING = 6;

export const MediaPanel = GObject.registerClass(
class MediaPanel extends Panel {
    _init(daemon, settings, {kind, paste, openPreferences}) {
        const gif = kind === 'gif';
        super._init({
            placeholder: gif ? 'Search GIFs' : 'Search stickers',
            styleClass: 'nkb-media-panel',
            tabs: [
                {id: 'online', label: gif ? 'GIFs' : 'Stickers'},
                {id: 'favorites', label: 'Favourites', icon: 'starred-symbolic'},
                {id: 'mine', label: 'Mine', icon: 'user-home-symbolic'},
            ],
        });
        this._daemon = daemon;
        this._settings = settings;
        this._kind = kind;
        this._paste = paste;
        this._openPreferences = openPreferences;
        this._requestId = null;
        this._loading = false;
        this._exhausted = false;
        this._count = 0;
        this._serial = 0;
        this._thumbs = new Map(); // id -> [AnimatedImage]

        this._addButton = iconButton('list-add-symbolic', {
            styleClass: 'nkb-flat',
            accessibleName: 'Add your own',
            onTap: () => {
                this.showStatus('Choose files in the dialog…');
                this._daemon.importOwnMedia([], '').catch(e => this.showStatus(e.message));
            },
        });
        this._extraHeader.add_child(this._addButton);

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this.status);
        // Rows of equal tiles, laid out by hand (see EmojiPanel._fillGrid).
        this._grid = new St.BoxLayout({
            style_class: 'nkb-media-grid',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._cells = [];
        box.add_child(this._grid);
        this.scrollView.child = box;

        this.scrollView.vadjustment.connect('notify::value', adj => {
            // Diagnosing GIFs vanishing after they load (a NaN scroll position).
            if (!Number.isFinite(adj.value)) {
                console.trace(`NextKeyBor media: scroll value ${adj.value} (upper ${adj.upper}, page ${adj.page_size})`);
                adj.value = 0;
                return;
            }
            this._maybeLoadMore();
        });

        daemon.connectObject(
            'MediaResults', (_d, requestId, json) => this._onResults(requestId, json),
            'MediaError', (_d, requestId, message) => {
                console.log(`NextKeyBor media: error ${message}`);
                if (requestId === this._requestId) {
                    this._loading = false;
                    this.showStatus(message);
                }
            },
            'MediaPreviewReady', (_d, id, path) => {
                for (const t of this._thumbs.get(id) ?? [])
                    t.setFile(path);
            },
            'FavoritesChanged', () => {
                if (this.tab === 'favorites')
                    this.refresh();
            },
            'OwnMediaChanged', () => {
                this.showStatus('');
                if (this.tab === 'mine')
                    this.refresh();
            },
            this);
        this._providerState = this._providerKey();
        settings.connectObject('changed', (_s, key) => {
            if (!key.endsWith('api-key') && key !== 'gif-provider')
                return;
            const state = this._providerKey();
            if (state !== this._providerState) {
                this._providerState = state;
                this.refresh();
            }
        }, this);

        this.setTab('online');
    }

    _providerKey() {
        const provider = this._settings.get_string('gif-provider');
        if (provider === 'openverse')
            return provider;
        return `${provider}:${this._settings.get_string(`${provider}-api-key`)}`;
    }

    _clear() {
        this._grid.destroy_all_children();
        this._cells = [];
        this._thumbs.clear();
        this._count = 0;
        this._exhausted = false;
        this.scrollView.vadjustment.value = 0;
    }

    async refresh() {
        const serial = ++this._serial;
        this._addButton.visible = this.tab === 'mine';
        this.showStatus('');
        this._requestId = null;
        this._loading = false;

        if (this.tab === 'online') {
            this._clear();
            this._loadPage();
            return;
        }

        let items;
        try {
            items = this.tab === 'favorites'
                ? await this._daemon.listFavorites(this._kind, this.query)
                : await this._daemon.listOwnMedia(this.query);
        } catch (e) {
            if (serial === this._serial)
                this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
            return;
        }
        if (serial !== this._serial)
            return;
        this._clear();
        this._exhausted = true;
        if (!items.length) {
            this.showStatus(this.tab === 'favorites'
                ? 'No favourites yet — long-press a GIF to add it.'
                : 'No GIFs of your own yet — tap + to add some.');
        }
        this._addItems(items);
    }

    async _loadPage() {
        if (this._loading || this._exhausted)
            return;
        this._loading = true;
        try {
            this._requestId = await this._daemon.searchMedia(this._kind, this.query, this._count);
        } catch (e) {
            this._loading = false;
            this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
        }
    }

    _onResults(requestId, json) {
        if (requestId !== this._requestId || this.tab !== 'online')
            return;
        this._loading = false;
        let items = [];
        try {
            items = JSON.parse(json);
        } catch {}
        if (!items.length) {
            this._exhausted = true;
            if (this._count === 0)
                this.showStatus('Nothing found');
            return;
        }
        this._addItems(items);
        // Fill the view if the first page was not enough to scroll.
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._maybeLoadMore();
            return GLib.SOURCE_REMOVE;
        });
    }

    _maybeLoadMore() {
        if (this.tab !== 'online' || this._loading || this._exhausted)
            return;
        const adj = this.scrollView.vadjustment;
        if (adj.value + adj.page_size >= adj.upper - PAGE_LOAD_MARGIN)
            this._loadPage();
    }

    _tileSize() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = (this.expanded ? 120 : 88) * scale;
        return [Math.round(height * MEDIA_TILE_RATIO), height];
    }

    _columns() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = this.width > 0 ? this.width : global.stage.width;
        return Math.max(1, Math.floor((width - 16 * scale) / (this._tileSize()[0] + MEDIA_SPACING * scale)));
    }

    // Puts a tile in the last row, starting a new row when it is full.
    _place(cell) {
        let row = this._grid.get_last_child();
        if (!row || row.get_n_children() >= this._columns()) {
            row = new St.BoxLayout({style_class: 'nkb-media-row'});
            this._grid.add_child(row);
        }
        row.add_child(cell);
    }

    _reflow() {
        for (const cell of this._cells)
            cell.get_parent()?.remove_child(cell);
        this._grid.destroy_all_children();
        for (const cell of this._cells)
            this._place(cell);
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const width = Math.round(box.get_width());
        if (width !== this._flowWidth) {
            this._flowWidth = width;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._reflow();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _addItems(items) {
        const [tileWidth, height] = this._tileSize();
        for (const item of items) {
            this._count++;
            // A fixed tile; the GIF keeps its shape, centred and cropped.
            const cell = new St.Widget({
                style_class: 'nkb-media-cell',
                layout_manager: new Clutter.BinLayout(),
                accessible_name: item.title ?? '',
                width: tileWidth,
                height,
                clip_to_allocation: true,
            });
            const image = new AnimatedImage({
                height,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            cell.add_child(image);
            if (item.preview)
                image.setFile(item.preview);
            const list = this._thumbs.get(item.id) ?? [];
            list.push(image);
            this._thumbs.set(item.id, list);

            const star = new St.Icon({
                icon_name: 'starred-symbolic',
                style_class: 'nkb-fav-badge',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                visible: !!item.favorite,
            });
            cell.add_child(star);

            connectTap(cell, {
                onTap: () => this._activate(item),
                onLongPress: () => {
                    item.favorite = !item.favorite;
                    star.visible = item.favorite;
                    this._daemon.setFavorite(item, item.favorite).catch(e => this.showStatus(e.message));
                    this.showStatus(item.favorite ? 'Added to favourites' : 'Removed from favourites');
                },
            });
            this._cells.push(cell);
            this._place(cell);
        }
    }

    async _activate(item) {
        this.showStatus('Inserting…');
        try {
            await this._paste(item);
            this.showStatus('');
        } catch (e) {
            this.showStatus(`Could not insert: ${e.message}`);
        }
    }
});

// ---------------------------------------------------------------------------

export const LanguagePanel = GObject.registerClass(
class LanguagePanel extends Panel {
    _init(daemon, settings) {
        super._init({
            placeholder: 'Search languages',
            styleClass: 'nkb-language-panel',
            tabs: [
                {id: 'speech', label: 'Dictation', icon: 'audio-input-microphone-symbolic'},
                {id: 'layouts', label: 'Layouts', icon: 'input-keyboard-symbolic'},
                {id: 'download', label: 'Download', icon: 'folder-download-symbolic'},
            ],
        });
        this._daemon = daemon;
        this._settings = settings;
        this._serial = 0;
        this._progress = new Map(); // "lang:pl_PL" -> St.Label

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this.status);
        this._list = new St.BoxLayout({
            style_class: 'nkb-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(this._list);
        this.scrollView.child = box;

        daemon.connectObject(
            'DownloadProgress', (_d, what, fraction) => {
                const label = this._progress.get(what);
                if (label)
                    label.text = `${Math.round(fraction * 100)} %`;
            },
            'DownloadFinished', (_d, what, success, message) => {
                const label = this._progress.get(what);
                if (label)
                    label.text = success ? 'Installed' : 'Failed';
                if (!success && message)
                    this.showStatus(message);
                if (success)
                    this.refresh();
            }, this);

        this.setTab('speech');
    }

    _row(title, subtitle, {checked = false, action = null, onTap = null, progressKey = null} = {}) {
        const row = new St.BoxLayout({style_class: 'nkb-row', x_expand: true, reactive: true});
        if (checked)
            row.add_style_pseudo_class('checked');
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        text.add_child(new St.Label({text: title, style_class: 'nkb-row-title'}));
        if (subtitle)
            text.add_child(new St.Label({text: subtitle, style_class: 'nkb-row-subtitle'}));
        row.add_child(text);
        if (checked)
            row.add_child(new St.Icon({icon_name: 'object-select-symbolic', style_class: 'nkb-row-icon'}));
        if (action) {
            const label = new St.Label({style_class: 'nkb-row-progress', y_align: Clutter.ActorAlign.CENTER});
            if (progressKey)
                this._progress.set(progressKey, label);
            row.add_child(label);
            row.add_child(labelButton(action.label, {
                styleClass: 'nkb-pill',
                onTap: () => {
                    label.text = '…';
                    action.run().catch(e => {
                        label.text = '';
                        this.showStatus(e.message);
                    });
                },
            }));
        }
        if (onTap)
            connectTap(row, {onTap});
        this._list.add_child(row);
        return row;
    }

    _header(text) {
        this._list.add_child(new St.Label({text, style_class: 'nkb-list-header'}));
    }

    _matches(...fields) {
        const q = this.query.trim().toLowerCase();
        return !q || fields.some(f => f?.toLowerCase().includes(q));
    }

    async refresh() {
        const serial = ++this._serial;
        this.showStatus('');
        try {
            if (this.tab === 'speech')
                await this._fillSpeech(serial);
            else if (this.tab === 'layouts')
                this._fillLayouts();
            else
                await this._fillDownloads(serial);
        } catch (e) {
            if (serial === this._serial)
                this.showStatus(`NextKeyBor daemon unavailable: ${e.message}`);
        }
    }

    _reset() {
        this._list.destroy_all_children();
        this._progress.clear();
        this.scrollView.vadjustment.value = 0;
    }

    async _fillSpeech(serial) {
        const languages = await this._daemon.listSpeechLanguages();
        if (serial !== this._serial)
            return;
        this._reset();
        const current = this._settings.get_string('speech-language');
        const recent = this._settings.get_strv('speech-recent-languages');
        const byCode = new Map(languages.map(l => [l.code, l]));
        const pick = code => {
            this._settings.set_string('speech-language', code);
            const updated = [code, ...recent.filter(c => c !== code)].slice(0, 6);
            this._settings.set_strv('speech-recent-languages', updated);
            this.emit('close-request');
        };
        const add = lang => this._row(lang.name, lang.code === 'auto' ? 'Detect automatically' : lang.code, {
            checked: lang.code === current,
            onTap: () => pick(lang.code),
        });

        const recentLangs = recent.map(c => byCode.get(c) ?? (c === 'auto' ? {code: 'auto', name: 'Automatic'} : null))
            .filter(l => l && this._matches(l.name, l.code));
        if (recentLangs.length) {
            this._header('Recent');
            recentLangs.forEach(add);
        }
        const rest = languages.filter(l => !recent.includes(l.code) && this._matches(l.name, l.code));
        if (rest.length) {
            this._header('All dictation languages');
            rest.forEach(add);
        }
        if (!recentLangs.length && !rest.length)
            this.showStatus('No matching language');
    }

    _fillLayouts() {
        this._reset();
        const manager = InputSourceManager.getInputSourceManager();
        const current = manager.currentSource;
        const sources = Object.values(manager.inputSources ?? {});
        this._header('Keyboard layouts (system input sources)');
        for (const source of sources) {
            if (!this._matches(source.displayName, source.shortName, source.id))
                continue;
            this._row(source.displayName, source.id, {
                checked: source === current,
                onTap: () => {
                    source.activate(true);
                    this.emit('close-request');
                },
            });
        }
        this.showStatus(sources.length > 1 ? '' : 'Add more layouts in the Download tab or in Settings → Keyboard.');
    }

    async _fillDownloads(serial) {
        const [languages, models] = await Promise.all([
            this._daemon.listLanguages(),
            this._daemon.listSpeechModels(),
        ]);
        if (serial !== this._serial)
            return;
        this._reset();
        const active = this._settings.get_string('active-language');

        this._header('Typing languages (dictionary + keyboard layout)');
        for (const lang of languages) {
            if (!this._matches(lang.name, lang.code))
                continue;
            const installed = lang.dictionary && (!lang.layout || lang.layout_enabled);
            const subtitle = [
                lang.code,
                lang.dictionary ? 'dictionary ✓' : 'no dictionary',
                lang.layout ? (lang.layout_enabled ? `layout ${lang.layout} ✓` : `layout ${lang.layout}`) : null,
            ].filter(Boolean).join(' · ');
            this._row(lang.name, subtitle, {
                checked: lang.code === active,
                onTap: lang.dictionary ? () => {
                    this._settings.set_string('active-language', lang.code);
                    this._daemon.setActiveLanguage(lang.code).catch(() => {});
                    this.refresh();
                } : null,
                action: installed ? null : {
                    label: 'Install',
                    run: () => this._daemon.installLanguage(lang.code),
                },
                progressKey: `lang:${lang.code}`,
            });
        }

        this._header('Speech models (whisper.cpp)');
        for (const model of models) {
            if (!this._matches(model.name))
                continue;
            const subtitle = `${model.size_mb} MB · ${model.multilingual ? 'multilingual' : 'English only'}`;
            this._row(model.name, subtitle, {
                checked: !!model.active,
                onTap: model.installed ? () => {
                    this._settings.set_string('speech-model', model.name);
                    this.refresh();
                } : null,
                action: model.installed ? null : {
                    label: 'Download',
                    run: () => this._daemon.downloadSpeechModel(model.name),
                },
                progressKey: `model:${model.name}`,
            });
        }
    }
});
