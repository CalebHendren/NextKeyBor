// Skins: colours, shapes and fonts for the keyboard (setting skin).
//
// A skin is a JSON file of a few values (see skins/dark.json), turned into a
// stylesheet that sits on top of the stock keyboard theme and
// stylesheet.css, or a plain CSS file for full control. Built-in skins live
// in the extension's skins/ folder and the user's own in
// ~/.local/share/nextkeybor/skins/. "shell" adds nothing, so the keyboard
// follows the shell theme, and "pywal" takes its colours from pywal's
// ~/.cache/wal/colors.json, following wallpaper changes.
//
// No shell imports: prefs.js uses this module too (lib/skinLoader.js loads
// skins into the shell).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULT_SKIN = 'shell';
export const PYWAL_SKIN = 'pywal';
const USER_PREFIX = 'user/';
const FIRST_BUILT_IN = ['light', 'dark', 'high-contrast']; // then the rest A–Z

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// The stock dark keyboard (gnome-shell-dark.css), for previews of "shell".
const SHELL_LOOK = {
    name: 'Shell theme',
    background: '#2e2e33',
    key: '#5d5d5d',
    'special-key': '#454545',
    'key-text': '#ffffff',
};

export function userSkinsDir() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'nextkeybor', 'skins']));
}

export function pywalFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'wal', 'colors.json']));
}

function readText(file) {
    const [, bytes] = file.load_contents(null);
    return new TextDecoder().decode(bytes);
}

function niceName(stem) {
    return stem.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());
}

function skinFiles(dir) {
    const files = [];
    let iter;
    try {
        iter = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return files;
    }
    for (let info; (info = iter.next_file(null));) {
        const name = info.get_name();
        if (info.get_file_type() === Gio.FileType.REGULAR && /\.(json|css)$/.test(name))
            files.push(name);
    }
    iter.close(null);
    return files.sort();
}

// [{id, name, user}] in the order the picker shows them.
export function listSkins(extensionDir) {
    const skins = [{id: DEFAULT_SKIN, name: SHELL_LOOK.name, user: false}];
    const builtIn = extensionDir.get_child('skins');
    const rank = id => (FIRST_BUILT_IN.includes(id) ? FIRST_BUILT_IN.indexOf(id) : FIRST_BUILT_IN.length);
    const ids = skinFiles(builtIn).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    for (const id of ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)))
        skins.push({id, name: skinName(builtIn.get_child(`${id}.json`), id), user: false});
    skins.push({id: PYWAL_SKIN, name: 'Wallpaper (pywal)', user: false});
    for (const file of skinFiles(userSkinsDir())) {
        const id = USER_PREFIX + file;
        skins.push({id, name: skinName(userSkinsDir().get_child(file), file.replace(/\.(json|css)$/, '')), user: true});
    }
    return skins;
}

function skinName(file, stem) {
    if (file.get_basename().endsWith('.json')) {
        try {
            const name = JSON.parse(readText(file)).name;
            if (typeof name === 'string' && name.trim())
                return name.trim();
        } catch {}
    }
    return niceName(stem);
}

// The file a skin id refers to (null for "shell").
export function skinFile(id, extensionDir) {
    if (id === DEFAULT_SKIN)
        return null;
    if (id === PYWAL_SKIN)
        return pywalFile();
    if (id.startsWith(USER_PREFIX)) {
        const name = id.slice(USER_PREFIX.length);
        return name && !name.includes('/') ? userSkinsDir().get_child(name) : null;
    }
    return /^[\w-]+$/.test(id) ? extensionDir.get_child('skins').get_child(`${id}.json`) : null;
}

// {kind: 'none'} for the shell theme, {kind: 'css', file} for a CSS skin,
// or {kind: 'json', skin, dir} with the skin's values (dir resolves a
// relative background image). Throws if the file is missing or broken.
export function loadSkin(id, extensionDir) {
    const file = skinFile(id, extensionDir);
    if (!file)
        return {kind: 'none'};
    if (file.get_basename().endsWith('.css'))
        return {kind: 'css', file};
    const data = JSON.parse(readText(file));
    if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new Error(`${file.get_path()} is not a JSON object`);
    const skin = id === PYWAL_SKIN ? fromPywal(data) : data;
    return {kind: 'json', skin, dir: file.get_parent()};
}

// pywal's colors.json: the special background/foreground and 16 colours
// picked from the wallpaper.
function fromPywal(wal) {
    const special = wal.special ?? {};
    const colors = wal.colors ?? {};
    return {
        name: 'Wallpaper (pywal)',
        background: special.background ?? colors.color0,
        'key-text': special.foreground ?? colors.color15,
        accent: colors.color4,
        'accent-text': special.background ?? colors.color0,
    };
}

// --- Colours. Values the parser knows are mixed here; anything else (such
// as -st-accent-color) is left to St's own st-mix() and friends.

export function parseColor(text) {
    if (typeof text !== 'string')
        return null;
    const s = text.trim().toLowerCase();
    let m = s.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (m) {
        let hex = m[1];
        if (hex.length <= 4)
            hex = [...hex].map(c => c + c).join('');
        const n = i => parseInt(hex.slice(i, i + 2), 16);
        return {r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1};
    }
    m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m)
        return {r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4]};
    if (s === 'transparent')
        return {r: 0, g: 0, b: 0, a: 0};
    if (s === 'white')
        return {r: 255, g: 255, b: 255, a: 1};
    if (s === 'black')
        return {r: 0, g: 0, b: 0, a: 1};
    return null;
}

function formatColor({r, g, b, a}) {
    const c = v => Math.round(clamp(v, 0, 255));
    return a >= 1 ? `#${[r, g, b].map(v => c(v).toString(16).padStart(2, '0')).join('')}`
        : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
}

// `amount` of a in b, as St's st-mix(a, b, amount).
function mix(a, b, amount) {
    const ca = parseColor(a), cb = parseColor(b);
    if (!ca || !cb)
        return `st-mix(${a}, ${b}, ${Math.round(amount * 100)}%)`;
    const m = (x, y) => y + (x - y) * amount;
    return formatColor({r: m(ca.r, cb.r), g: m(ca.g, cb.g), b: m(ca.b, cb.b), a: m(ca.a, cb.a)});
}

function withAlpha(color, alpha) {
    const c = parseColor(color);
    if (!c)
        return `st-transparentize(${color}, ${1 - alpha})`;
    return formatColor({...c, a: c.a * alpha});
}

// A colour value safe to put in a stylesheet.
function cssColor(value) {
    if (parseColor(value) || value === '-st-accent-color' || value === '-st-accent-fg-color')
        return value;
    return null;
}

function cssNumber(value, min, max) {
    const n = Number(value);
    return value !== undefined && value !== null && value !== '' && Number.isFinite(n)
        ? clamp(n, min, max) : null;
}

// The skin's values with every gap filled in; also what prefs previews.
export function resolveSkin(skin) {
    const s = skin.kind === undefined ? skin : skin.skin;
    const background = cssColor(s.background) ?? SHELL_LOOK.background;
    const text = cssColor(s['key-text']) ?? '#ffffff';
    const key = cssColor(s.key) ?? mix(text, background, 0.14);
    const special = cssColor(s['special-key']) ?? mix(text, background, 0.07);
    return {
        name: typeof s.name === 'string' ? s.name : '',
        background,
        key,
        keyText: text,
        specialKey: special,
        specialKeyText: cssColor(s['special-key-text']) ?? text,
        accent: cssColor(s.accent) ?? '-st-accent-color',
        accentText: cssColor(s['accent-text']) ?? (cssColor(s.accent) ? background : '-st-accent-fg-color'),
        toolbarText: cssColor(s['toolbar-text']) ?? text,
        radius: cssNumber(s['key-radius'], 0, 64),
        gap: cssNumber(s['key-gap'], 0, 32),
        borderWidth: cssNumber(s['key-border-width'], 0, 8),
        borderColor: cssColor(s['key-border-color']),
        shadow: s['key-shadow'] !== false,
        font: typeof s.font === 'string' && /^[\w ,'"-]+$/.test(s.font) ? s.font : null,
        bold: s['font-weight'] === undefined ? null : s['font-weight'] !== 'normal',
        backgroundImage: typeof s['background-image'] === 'string' ? s['background-image'] : null,
        css: typeof s.css === 'string' ? s.css : '',
    };
}

export function shellLook() {
    return resolveSkin(SHELL_LOOK);
}

// The background image as a file, relative paths taken from `dir`.
export function backgroundImageFile(resolved, dir) {
    const path = resolved.backgroundImage;
    if (!path)
        return null;
    if (path.startsWith('~/'))
        return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]));
    return GLib.path_is_absolute(path) ? Gio.File.new_for_path(path) : dir?.resolve_relative_path(path) ?? null;
}

const rule = (selectors, props) => {
    const body = Object.entries(props).filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `  ${k}: ${v};`).join('\n');
    return body ? `${[selectors].flat().join(',\n')} {\n${body}\n}\n` : '';
};

// Each selector with each suffix (":hover", ".default-key:active", …).
const states = (selectors, ...suffixes) => selectors.flatMap(s => suffixes.map(x => s + x));

// The stylesheet for a JSON skin. Selectors start at #keyboard (or the
// popups shown outside it), so they win over the stock theme's.
export function skinCss(loaded) {
    const s = resolveSkin(loaded);
    const keys = ['#keyboard .keyboard-key', '.keyboard-subkeys-boxpointer .keyboard-key'];
    const hover = c => mix(s.keyText, c, 0.08);
    const pressed = c => mix(s.keyText, c, 0.18);
    const image = backgroundImageFile(s, loaded.dir);
    const border = s.borderWidth !== null
        ? `${s.borderWidth}px solid ${s.borderColor ?? withAlpha(s.keyText, 0.25)}` : null;
    const tools = ['.nkb-tool-button', '.nkb-suggestion', '.nkb-category', '.nkb-emoji', '.nkb-row', '.nkb-one-handed-button']
        .map(c => `#keyboard ${c}`);
    const texts = ['.word-suggestions', '.nkb-tool-button', '.nkb-suggestion', '.nkb-toolbar-status', '.nkb-query',
        '.nkb-status', '.nkb-hint', '.nkb-category', '.nkb-emoji', '.nkb-row', '.nkb-edit-title', '.nkb-edit-key',
        '.nkb-one-handed-button'].map(c => `#keyboard ${c}`);
    const faint = ['.nkb-row-subtitle', '.nkb-list-header', '.nkb-query-label.nkb-placeholder', '.nkb-query-icon',
        '.nkb-row-progress'].map(c => `#keyboard ${c}`);

    let css = `/* NextKeyBor skin${s.name ? `: ${s.name.replace(/\*\//g, '')}` : ''} (generated) */\n`;
    css += rule('#keyboard', {
        'background-color': s.background,
        'background-image': image ? `url("${image.get_uri()}")` : null,
        'background-size': image ? 'cover' : null,
        'background-position': image ? 'center' : null,
        'font-family': s.font,
    });
    css += rule('.keyboard-subkeys-boxpointer', {
        '-arrow-background-color': s.background,
        '-arrow-border-color': s.borderColor ?? withAlpha(s.keyText, 0.15),
        'font-family': s.font,
    });
    if (s.gap !== null) {
        css += rule(['#keyboard .key-container'], {padding: `${s.gap / 2}px`});
    }
    css += rule(keys, {
        color: s.keyText,
        'background-color': s.key,
        'border-radius': s.radius === null ? null : `${s.radius}px`,
        border: border,
        'box-shadow': s.shadow ? null : 'none',
        'font-weight': s.bold === null ? null : s.bold ? 'bold' : 'normal',
    });
    css += rule(states(keys, ':hover', ':focus'), {color: s.keyText, 'background-color': hover(s.key)});
    css += rule(states(keys, ':active', ':checked', ':active:hover', ':checked:hover'),
        {color: s.keyText, 'background-color': pressed(s.key)});
    css += rule(states(keys, '.default-key'), {color: s.specialKeyText, 'background-color': s.specialKey});
    css += rule(states(keys, '.default-key:hover', '.default-key:focus'),
        {color: s.specialKeyText, 'background-color': hover(s.specialKey)});
    css += rule(states(keys, '.default-key:active', '.default-key:checked', '.default-key:active:hover',
        '.default-key:checked:hover'), {color: s.specialKeyText, 'background-color': pressed(s.specialKey)});
    css += rule(states(keys, '.default-key:latched'), {color: s.accentText, 'background-color': s.accent});
    css += rule(['#keyboard .emoji-page .keyboard-key'],
        {'background-color': 'transparent', border: 'none', 'box-shadow': 'none'});

    // NextKeyBor's own toolbar, suggestion bar and panels (stylesheet.css).
    css += rule(texts, {color: s.toolbarText});
    css += rule(faint, {color: withAlpha(s.toolbarText, 0.65)});
    css += rule(states(tools, ':hover'), {'background-color': withAlpha(s.toolbarText, 0.1)});
    css += rule(states(tools, ':active'), {'background-color': withAlpha(s.toolbarText, 0.2)});
    css += rule(states(tools, ':checked'), {'background-color': mix(s.accent, s.background, 0.6)});
    css += rule(['#keyboard .nkb-mic.nkb-recording'], {color: '#ffffff'});
    css += rule(['#keyboard .nkb-one-handed-button'], {'background-color': withAlpha(s.toolbarText, 0.1)});
    css += rule(['#keyboard .nkb-query', '#keyboard .nkb-variant-bar', '#keyboard .nkb-hint'],
        {'background-color': withAlpha(s.toolbarText, 0.08)});
    css += rule(['#keyboard .nkb-edit-key'], {
        'background-color': s.key,
        'border-radius': s.radius === null ? null : `${s.radius}px`,
        border: border,
    });
    css += rule(['#keyboard .nkb-edit-key:active'], {'background-color': pressed(s.key)});
    css += rule(['#keyboard .nkb-edit-key:checked'], {color: s.accentText, 'background-color': s.accent});
    css += rule(['#keyboard .nkb-resize-pill'], {'background-color': withAlpha(s.toolbarText, 0.3)});
    css += rule(['.nkb-key-popup'], {
        color: s.keyText,
        'background-color': hover(s.key),
        'border-radius': s.radius === null ? null : `${s.radius + 4}px`,
        border: border,
        'font-family': s.font,
    });
    if (s.css)
        css += `\n/* The skin's own CSS */\n${s.css}\n`;
    return css;
}
