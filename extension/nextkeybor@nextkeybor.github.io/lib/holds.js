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
