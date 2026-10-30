// Keyboard shapes other than the stock full-width block: the split keyboard
// in landscape (setting split-landscape).
//
// The stock keys keep a fixed aspect ratio and are centred, so a landscape
// keyboard leaves wide empty margins. Split mode instead puts empty columns
// in the middle of each row (lib/holds.js splitRow), enough that the two
// halves reach the screen edges, under the thumbs.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SPLIT_FILL = 0.97; // of the keyboard's width
const MAX_SPLIT_GAP = 16;
const MIN_SPLIT_ROW = 8; // narrower rows (number pads) are never split

// Keys of empty space between the halves of rows `width` keys wide, or 0
// when the keyboard is not split. numberRow: the level has the number row.
export function splitGap(keyboard, settings, floating, width, numberRow) {
    const monitor = Main.layoutManager.keyboardMonitor;
    if (!monitor || monitor.width <= monitor.height || width < MIN_SPLIT_ROW ||
        !settings.get_boolean('split-landscape') || floating?.enabled)
        return 0;
    const rows = (keyboard._nkbLetterRows ?? 4) + (numberRow ? 1 : 0);
    // The keys' height from the last allocation, or a guess before there
    // is one (the keyboard rebuilds once it knows; see KeyboardUi).
    const keysHeight = keyboard._nkbKeysHeight || (keyboard._nkbBaseHeight || monitor.height / 3) * 0.75;
    const padding = keyboard.get_stage() ? keyboard.get_theme_node().get_horizontal_padding() : 0;
    // Keys are square-ish: a column is as wide as a row is tall.
    const columns = (monitor.width - padding) * SPLIT_FILL * rows / keysHeight;
    return Math.clamp(Math.floor((columns - width) * 2) / 2, 1, MAX_SPLIT_GAP);
}
