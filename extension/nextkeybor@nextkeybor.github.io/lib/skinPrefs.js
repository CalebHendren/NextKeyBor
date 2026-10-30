// The Appearance page in Preferences: a picker of skins with a preview of
// each, plus buttons to copy, import, remove and find the user's own skins.
// Used by prefs.js only (it imports GTK).

import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {
    DEFAULT_SKIN, PYWAL_SKIN, backgroundImageFile, listSkins, loadSkin, parseColor, pywalFile,
    resolveSkin, shellLook, skinFile, userSkinsDir,
} from './skins.js';

const PREVIEW_WIDTH = 160;
const PREVIEW_HEIGHT = 84;
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

const MATUGEN_SETUP = `[templates.nextkeybor]
input_path = '~/.local/share/gnome-shell/extensions/nextkeybor@nextkeybor.github.io/templates/matugen.json'
output_path = '~/.local/share/nextkeybor/skins/matugen.json'`;

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A small keyboard in the skin's colours: suggestion bar, three letter rows
// and a bottom row of special keys around the space bar.
function drawPreview(cr, width, height, look, accent, image) {
    const colour = (value, fallback) => {
        const c = parseColor(value) ??
            (value?.includes('accent-fg') ? {r: 255, g: 255, b: 255, a: 1} : null) ??
            (value?.includes('accent') ? accent : null) ?? fallback;
        cr.setSourceRGBA(c.r / 255, c.g / 255, c.b / 255, c.a);
    };
    const grey = {r: 128, g: 128, b: 128, a: 1};
    roundedRect(cr, 0, 0, width, height, 8);
    cr.clip();
    colour(look.background, grey);
    cr.paint();
    if (image) {
        const scale = Math.max(width / image.get_width(), height / image.get_height());
        cr.save();
        cr.scale(scale, scale);
        Gdk.cairo_set_source_pixbuf(cr, image,
            (width / scale - image.get_width()) / 2, (height / scale - image.get_height()) / 2);
        cr.paint();
        cr.restore();
    }

    cr.selectFontFace(look.font?.split(',')[0].replace(/['"]/g, '').trim() || 'Sans',
        Cairo.FontSlant.NORMAL, look.bold === false ? Cairo.FontWeight.NORMAL : Cairo.FontWeight.BOLD);
    const bar = height * 0.2;
    cr.setFontSize(bar * 0.5);
    colour(look.toolbarText, grey);
    ['the', 'and', 'you'].forEach((word, i) => {
        const ext = cr.textExtents(word);
        cr.moveTo(width * (i + 0.5) / 3 - ext.width / 2, bar * 0.7);
        cr.showText(word);
    });

    const pad = 3;
    const gap = Math.min(look.gap ?? 4, 8) / 2;
    const keyW = (width - 2 * pad) / 10;
    const keyH = (height - bar - pad) / 4;
    const radius = (look.radius ?? 5) * keyH / 40;
    const key = (x, y, w, fill, text, label) => {
        roundedRect(cr, x + gap, y + gap, w - 2 * gap, keyH - 2 * gap, radius);
        colour(fill, grey);
        if (look.borderWidth) {
            cr.fillPreserve();
            cr.setLineWidth(Math.max(1, look.borderWidth / 2));
            colour(look.borderColor ?? look.keyText, grey);
            cr.stroke();
        } else {
            cr.fill();
        }
        if (label) {
            cr.setFontSize(keyH * 0.45);
            const ext = cr.textExtents(label);
            colour(text, grey);
            cr.moveTo(x + w / 2 - ext.width / 2 - ext.xBearing, y + keyH / 2 + ext.height / 2);
            cr.showText(label);
        }
    };
    ROWS.forEach((letters, row) => {
        const y = bar + row * keyH;
        let x = pad + (10 - letters.length) * keyW / 2;
        if (row === 2) {
            key(pad, y, keyW * 1.5, look.accent, look.accentText, '');
            x = pad + keyW * 1.5;
        }
        for (const ch of letters) {
            key(x, y, keyW, look.key, look.keyText, ch);
            x += keyW;
        }
        if (row === 2)
            key(x, y, width - pad - x, look.specialKey, look.specialKeyText, '');
    });
    const y = bar + 3 * keyH;
    key(pad, y, keyW * 1.5, look.specialKey, look.specialKeyText, '');
    key(pad + keyW * 1.5, y, keyW * 7, look.key, look.keyText, '');
    key(pad + keyW * 8.5, y, keyW * 1.5, look.specialKey, look.specialKeyText, '');
}

// What the picker shows for a skin: its resolved values, a background image
// and whether it can be used at all.
function lookOf(id, extensionDir) {
    if (id === DEFAULT_SKIN)
        return {look: shellLook()};
    try {
        const loaded = loadSkin(id, extensionDir);
        if (loaded.kind === 'css')
            return {look: null, note: 'CSS skin'};
        const look = resolveSkin(loaded);
        let image = null;
        const file = backgroundImageFile(look, loaded.dir);
        if (file) {
            try {
                image = GdkPixbuf.Pixbuf.new_from_file_at_scale(file.get_path(), PREVIEW_WIDTH * 2, -1, true);
            } catch {}
        }
        return {look, image};
    } catch (e) {
        return {look: null, note: id === PYWAL_SKIN ? 'Run pywal first' : 'Cannot be read', broken: true,
            error: e.message};
    }
}

function uniqueFile(dir, stem, ext) {
    for (let i = 1; ; i++) {
        const file = dir.get_child(i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
        if (!file.query_exists(null))
            return file;
    }
}

function writeText(file, text) {
    GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
    file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.NONE, null);
}

// A JSON skin with every value written out, to edit by hand.
function editableCopy(id, extensionDir) {
    const loaded = id === DEFAULT_SKIN ? {kind: 'json', skin: {}} : loadSkin(id, extensionDir);
    if (loaded.kind === 'css')
        return {ext: '.css', text: new TextDecoder().decode(loaded.file.load_contents(null)[1])};
    const s = id === DEFAULT_SKIN ? shellLook() : resolveSkin(loaded);
    const image = backgroundImageFile(s, loaded.dir);
    const skin = {
        name: `${s.name || 'My skin'} (copy)`,
        background: s.background,
        key: s.key,
        'special-key': s.specialKey,
        'key-text': s.keyText,
        'special-key-text': s.specialKeyText,
        'toolbar-text': s.toolbarText,
        accent: s.accent,
        'accent-text': s.accentText,
        'key-radius': s.radius ?? 8,
        'key-gap': s.gap ?? 8,
        'key-border-width': s.borderWidth ?? 0,
        'key-border-color': s.borderColor ?? s.keyText,
        'key-shadow': s.shadow,
        font: s.font ?? '',
        'font-weight': s.bold === false ? 'normal' : 'bold',
        'background-image': image?.get_path() ?? '',
        css: s.css,
    };
    // The derived St expressions (st-mix…) are not valid values in a file.
    for (const [k, v] of Object.entries(skin)) {
        if (typeof v === 'string' && v.startsWith('st-'))
            delete skin[k];
    }
    return {ext: '.json', text: `${JSON.stringify(skin, null, 2)}\n`};
}

// JSON files often open in a web browser, so use the text editor.
function openInEditor(window, file) {
    const editor = Gio.AppInfo.get_default_for_type('text/plain', false);
    if (editor)
        editor.launch([file], window.get_display().get_app_launch_context());
    else
        new Gtk.FileLauncher({file}).launch(window, null, null);
}

export function appearancePage(window, settings, extensionDir) {
    const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});

    const pick = new Adw.PreferencesGroup({
        title: 'Skin',
        description: 'Colours, shapes and fonts for the keyboard. Changes show straight away.',
    });
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.SINGLE,
        homogeneous: true,
        max_children_per_line: 3,
        min_children_per_line: 2,
        column_spacing: 6,
        row_spacing: 6,
        activate_on_single_click: true,
    });
    pick.add(flow);
    page.add(pick);

    const own = new Adw.PreferencesGroup({
        title: 'Your skins',
        description: 'A skin is a JSON file of colours and sizes, or a CSS file, in the skins folder. ' +
            'Saved changes show on the keyboard straight away.',
    });
    const button = (label, tooltip = '') =>
        new Gtk.Button({label, valign: Gtk.Align.CENTER, tooltip_text: tooltip});
    const copyRow = new Adw.ActionRow({title: 'Edit a copy of the chosen skin', subtitle: 'Opens it in your text editor'});
    const copyButton = button('Copy');
    const removeButton = button('Remove', 'Delete the chosen skin from the skins folder');
    removeButton.add_css_class('destructive-action');
    copyRow.add_suffix(removeButton);
    copyRow.add_suffix(copyButton);
    own.add(copyRow);
    const folderRow = new Adw.ActionRow({title: 'Skins folder', subtitle: userSkinsDir().get_path()});
    const importButton = button('Import…', 'Copy a .json or .css skin into the skins folder');
    const openButton = button('Open');
    folderRow.add_suffix(importButton);
    folderRow.add_suffix(openButton);
    own.add(folderRow);
    const errorRow = new Adw.ActionRow({title: 'This skin cannot be used', visible: false});
    errorRow.add_css_class('error');
    own.add(errorRow);
    page.add(own);

    const wall = new Adw.PreferencesGroup({
        title: 'Follow the wallpaper',
        description: 'pywal: choose Wallpaper (pywal) above; it changes with each run of wal. ' +
            'matugen: add this template to ~/.config/matugen/config.toml, run matugen, then choose Wallpaper (matugen).',
    });
    const matugenRow = new Adw.ActionRow({title: 'matugen template', subtitle: 'templates.nextkeybor'});
    const copySetup = button('Copy setup', MATUGEN_SETUP);
    copySetup.connect('clicked', () => {
        window.get_display().get_clipboard().set(MATUGEN_SETUP);
        window.add_toast(new Adw.Toast({title: 'Copied the matugen template setup'}));
    });
    matugenRow.add_suffix(copySetup);
    wall.add(matugenRow);
    page.add(wall);

    const accent = () => {
        const c = Adw.StyleManager.get_default().get_accent_color_rgba();
        return {r: c.red * 255, g: c.green * 255, b: c.blue * 255, a: 1};
    };

    let ids = [];
    let syncing = false;
    const current = () => settings.get_string('skin') || DEFAULT_SKIN;
    const select = () => {
        syncing = true;
        const i = ids.indexOf(current());
        if (i >= 0)
            flow.select_child(flow.get_child_at_index(i));
        else
            flow.unselect_all();
        syncing = false;
        const id = current();
        const user = id.startsWith('user/');
        removeButton.sensitive = user;
        const {broken, error} = lookOf(id, extensionDir);
        errorRow.visible = !!broken;
        errorRow.subtitle = error ? GLib.markup_escape_text(error, -1) : '';
    };
    const rebuild = () => {
        flow.remove_all();
        const skins = listSkins(extensionDir);
        ids = skins.map(s => s.id);
        for (const skin of skins) {
            const {look, image, note, broken} = lookOf(skin.id, extensionDir);
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 4,
                margin_bottom: 4, margin_start: 4, margin_end: 4});
            const area = new Gtk.DrawingArea({content_width: PREVIEW_WIDTH, content_height: PREVIEW_HEIGHT});
            if (look) {
                area.set_draw_func((_a, cr, w, h) => {
                    drawPreview(cr, w, h, look, accent(), image);
                    cr.$dispose();
                });
            } else {
                area.set_draw_func((_a, cr, w, h) => {
                    roundedRect(cr, 0, 0, w, h, 8);
                    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.15);
                    cr.fill();
                    cr.$dispose();
                });
            }
            box.append(area);
            const label = new Gtk.Label({label: skin.name, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 18});
            box.append(label);
            if (note) {
                const sub = new Gtk.Label({label: note});
                sub.add_css_class('dim-label');
                sub.add_css_class('caption');
                box.append(sub);
            }
            const child = new Gtk.FlowBoxChild({child: box, tooltip_text: skin.id});
            child.sensitive = !broken || skin.id === current();
            flow.append(child);
        }
        select();
    };

    // Choosing a card (by tap, or by moving the selection with the keys)
    // switches the keyboard to it.
    flow.connect('selected-children-changed', () => {
        const [child] = flow.get_selected_children();
        const id = child ? ids[child.get_index()] : null;
        if (!syncing && id && id !== current())
            settings.set_string('skin', id);
    });
    settings.connect('changed::skin', select);

    copyButton.connect('clicked', () => {
        try {
            const {ext, text} = editableCopy(current(), extensionDir);
            const file = uniqueFile(userSkinsDir(), 'my-skin', ext);
            writeText(file, text);
            rebuild();
            settings.set_string('skin', `user/${file.get_basename()}`);
            openInEditor(window, file);
        } catch (e) {
            window.add_toast(new Adw.Toast({title: `Could not copy the skin: ${e.message}`}));
        }
    });

    removeButton.connect('clicked', () => {
        const file = skinFile(current(), extensionDir);
        if (!file || !current().startsWith('user/'))
            return;
        const dialog = new Adw.AlertDialog({
            heading: 'Remove this skin?',
            body: `${file.get_basename()} will be deleted from the skins folder.`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('remove', 'Remove');
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(window, null, (d, res) => {
            if (d.choose_finish(res) !== 'remove')
                return;
            try {
                file.delete(null);
            } catch (e) {
                window.add_toast(new Adw.Toast({title: `Could not remove it: ${e.message}`}));
                return;
            }
            settings.set_string('skin', DEFAULT_SKIN);
            rebuild();
        });
    });

    openButton.connect('clicked', () => {
        GLib.mkdir_with_parents(userSkinsDir().get_path(), 0o755);
        new Gtk.FileLauncher({file: userSkinsDir()}).launch(window, null, null);
    });

    importButton.connect('clicked', () => {
        const filter = new Gtk.FileFilter({name: 'Skins (.json, .css)'});
        filter.add_suffix('json');
        filter.add_suffix('css');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: 'Import a skin', filters});
        dialog.open(window, null, (d, res) => {
            let source;
            try {
                source = d.open_finish(res);
            } catch {
                return; // cancelled
            }
            try {
                const name = source.get_basename();
                const ext = name.endsWith('.css') ? '.css' : '.json';
                const text = new TextDecoder().decode(source.load_contents(null)[1]);
                if (ext === '.json') {
                    // Check it, and bring a background image given by a relative path along.
                    const look = resolveSkin(JSON.parse(text));
                    const image = backgroundImageFile(look, source.get_parent());
                    const rel = look.backgroundImage;
                    if (image && rel && !GLib.path_is_absolute(rel) && !rel.startsWith('~/')) {
                        const target = userSkinsDir().resolve_relative_path(rel);
                        GLib.mkdir_with_parents(target.get_parent().get_path(), 0o755);
                        image.copy(target, Gio.FileCopyFlags.OVERWRITE, null, null);
                    }
                }
                const file = uniqueFile(userSkinsDir(), name.replace(/\.(json|css)$/, '').replace(/[^\w.-]+/g, '-'), ext);
                writeText(file, text);
                rebuild();
                settings.set_string('skin', `user/${file.get_basename()}`);
            } catch (e) {
                window.add_toast(new Adw.Toast({title: `Could not import the skin: ${e.message}`}));
            }
        });
    });

    // Keep the picker up to date with the skins folder and pywal's colours.
    GLib.mkdir_with_parents(userSkinsDir().get_path(), 0o755);
    const monitors = [userSkinsDir(), pywalFile().get_parent()].map(dir => {
        try {
            const monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            let id = 0;
            monitor.connect('changed', () => {
                if (id)
                    GLib.source_remove(id);
                id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    id = 0;
                    rebuild();
                    return GLib.SOURCE_REMOVE;
                });
            });
            return monitor;
        } catch {
            return null;
        }
    });
    page.connect('destroy', () => monitors.forEach(m => m?.cancel()));
    Adw.StyleManager.get_default().connect('notify::accent-color', () => rebuild());

    rebuild();
    return page;
}
