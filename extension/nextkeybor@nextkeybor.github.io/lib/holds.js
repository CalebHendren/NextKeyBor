// Layout tweaks on the layout JSON before the stock keyboard builds keys.
//
// Gboard-style long-press variants: digits on the top letter row, common
// symbols on the other letter rows. Works on the layout JSON before the stock
// keyboard turns it into keys; key.strings[0] is what a tap commits, the rest
// are the long-press popup.

const TOP_ROW = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const MIDDLE_ROW = ['@', '#', '$', '_', '&', '-', '+', '(', ')', '/'];
const BOTTOM_ROW = ['*', '"', '\'', ':', ';', '!', '?', '%', '='];

const EXTRA_VARIANTS = {
    ',': [';', ':', '!', '?', '"', '\'', '…'],
    '.': ['…'],
    '-': ['–', '—', '_', '·'],
    '\'': ['‘', '’', '"', '“', '”'],
    '/': ['\\', '|'],
    '?': ['¿', '‽'],
    '!': ['¡'],
};

const LETTER = /^\p{L}$/u;

function isLetterKey(key) {
    return !key.action && !key.keyval && key.strings?.length > 0 &&
        LETTER.test(key.strings[0]);
}

function addVariant(key, variant) {
    if (key.strings.includes(variant))
        return;
    key.strings.splice(1, 0, variant);
}

// `rowIndex` is 1-based, as KeyContainer counts rows. `levelMode` is the
// level's "mode": letters live on the "default" and "latched" (shift) levels.
export function augmentRow(keys, rowIndex, levelMode) {
    if (levelMode !== 'default' && levelMode !== 'latched')
        return;

    const table = [TOP_ROW, MIDDLE_ROW, BOTTOM_ROW][rowIndex - 1];
    let column = 0;
    for (const key of keys) {
        if (isLetterKey(key)) {
            if (table && column < table.length)
                addVariant(key, table[column]);
            column++;
            continue;
        }
        const extra = key.strings?.length ? EXTRA_VARIANTS[key.strings[0]] : null;
        if (extra) {
            for (const v of [...extra].reverse())
                addVariant(key, v);
        }
    }
}

// Long-press on the number row: superscripts and fractions, as on Gboard.
const DIGIT_VARIANTS = {
    '1': ['¹', '½', '⅓', '¼', '⅛'],
    '2': ['²', '⅔'],
    '3': ['³', '¾', '⅜'],
    '4': ['⁴'],
    '5': ['⅝'],
    '7': ['⅞'],
    '0': ['ⁿ', '∅'],
};

// The keys of a row of digits 1–0 to put above this row, lined up with its
// letters (the stock letter levels have no number row), or null when the row
// is not the top letter row. `rowIndex` and `levelMode` as for augmentRow.
export function numberRowFor(keys, rowIndex, levelMode) {
    if (rowIndex !== 1 || (levelMode !== 'default' && levelMode !== 'latched'))
        return null;
    const first = keys.findIndex(isLetterKey);
    if (first < 0 || keys.filter(isLetterKey).length < 7)
        return null;
    const offset = keys.slice(0, first).reduce((sum, k) => sum + (k.width ?? 1), 0);
    return TOP_ROW.map((digit, i) => ({
        strings: [digit, ...(DIGIT_VARIANTS[digit] ?? [])],
        leftOffset: i === 0 ? offset : 0,
    }));
}

// The stock URL layout's "www." key: a tap types ".com", the long-press popup
// offers other common endings, and keeps "www.".
const URL_ENDINGS = ['.com', '.org', '.net', '.io', '.dev', 'www.'];

export function replaceWwwKey(keys) {
    for (const key of keys) {
        if (!key.action && key.strings?.length === 1 && key.strings[0] === 'www.')
            key.strings = [...URL_ENDINGS];
    }
}

// Widen the space bar and centre it: the stock letter rows put it left of
// centre (the hide key is wider than ?123). Keys sit on a half-key grid, so
// the outermost key on each side gets 1.5 and the others 1.
export function centreSpaceBar(keys) {
    const space = keys.findIndex(k => k.strings?.[0] === ' ');
    if (space < 0 || (keys[space].width ?? 1) < 4)
        return; // only the letter levels' wide space bar
    const total = keys.reduce((sum, k) => sum + (k.width ?? 1), 0);
    const left = keys.slice(0, space), right = keys.slice(space + 1);
    const side = 1.5 + Math.max(left.length, right.length, 1) - 1;
    const width = total - 2 * side;
    if (width < (keys[space].width ?? 1))
        return;
    const fill = (group, outerFirst) => {
        group.forEach((k, i) => {
            k.width = (outerFirst ? i === 0 : i === group.length - 1) ? 1.5 : 1;
        });
        // A side with fewer keys takes the difference on its outer key.
        const short = side - group.reduce((sum, k) => sum + k.width, 0);
        if (group.length > 0 && short > 0)
            group[outerFirst ? 0 : group.length - 1].width += short;
    };
    fill(left, true);
    fill(right, false);
    keys[space].width = width;
}

// Split keyboard: rows split at the key boundary nearest this fraction of
// their width (qwert|yuiop, asdfg|hjkl, zxcv|bnm on the stock layouts).
export const SPLIT_AT = 0.46;

export function rowWidth(keys) {
    return keys.reduce((sum, k) => sum + (k.leftOffset ?? 0) + (k.width ?? 1), 0);
}

// Where to split the row: the index of the first key of its right half,
// at the key boundary nearest column `at`, or -1. A space bar across that
// column becomes two, one on each side of the split.
export function splitRow(keys, at) {
    let column = 0, best = -1, bestDistance = Infinity;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const start = column + (key.leftOffset ?? 0);
        const end = start + (key.width ?? 1);
        if (key.strings?.[0] === ' ' && !key.action && start < at && end > at) {
            const cut = Math.clamp(Math.round(at * 2) / 2, start + 0.5, end - 0.5);
            key.width = cut - start;
            keys.splice(i + 1, 0, {...key, strings: [...key.strings], width: end - cut, leftOffset: 0});
            return i + 1;
        }
        if (i > 0 && Math.abs(start - at) < bestDistance) {
            best = i;
            bestDistance = Math.abs(start - at);
        }
        column = end;
    }
    return best;
}
