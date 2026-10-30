#!/usr/bin/env python3
"""Tap out typos in the test session and check autocorrect and its undo.

    tools/nested/type_test.py [--layout clip|plain | --grid QX,STEP,Y1,Y2,Y3] DIR

Checks, on the stock US layout:
  "teh" + space        -> "the "  (corrected)
  then Backspace       -> "teh"   (put back as typed, and accepted)
  then space           -> "teh "  (not corrected again)
  "teh" + space again  -> "teh "  (still not corrected)

Needs the session from tools/nested/restart.sh with the keyboard open on the
letter level and no panel showing; --layout and --grid as for swipe_test.py.
The test session's daemon shares your word list, so "teh" is forgotten again
at the end (it is then never suggested).
"""
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from drive import Driver  # noqa: E402
from swipe_test import LAYOUTS  # noqa: E402

TYPING_S = 0.35  # after the last letter, so the correction is in before the space
SETTLE_S = 0.6


def key_positions(rows):
    """Letter centres, plus Backspace and the space bar, from the letter rows.

    The stock top row ends with a 1.5-key Backspace; NextKeyBor centres the
    space bar on the 11.5-key-wide keyboard, one row below the letters.
    """
    keys = {c: (x0 + i * step, y) for letters, x0, step, y in rows for i, c in enumerate(letters)}
    (_, qx, step, y1), (_, _, _, y2), (_, _, _, y3) = rows
    keys["\b"] = (qx + 10.25 * step, y1)
    keys[" "] = (qx + 5.25 * step, y3 + (y3 - y2))
    return keys


def main():
    args = sys.argv[1:]
    layout = "clip"
    while args and args[0].startswith("--"):
        opt = args.pop(0)
        if opt == "--layout":
            layout = args.pop(0)
        elif opt == "--grid":
            qx, step, y1, y2, y3 = (float(v) for v in args.pop(0).split(","))
            LAYOUTS["grid"] = [("qwertyuiop", qx, step, y1), ("asdfghjkl", qx + step / 2, step, y2),
                               ("zxcvbnm", qx + step, step, y3)]
            layout = "grid"
    keys = key_positions(LAYOUTS[layout])
    state = Path(args[0])
    bus = state.joinpath("bus").read_text().strip()
    text_file = state / "text.txt"
    d = Driver(bus)

    def text():
        return text_file.read_text() if text_file.exists() else ""

    def tap(chars):
        for c in chars:
            d.tap(*keys[c])

    # Start on a fresh word.
    if text() and not text()[-1].isspace():
        tap(" ")
        d.wait(1.2)  # past the double-space window
    start = text()
    ok = 0
    checks = [
        ("teh + space", lambda: (tap("teh"), d.wait(TYPING_S), tap(" ")), "the "),
        ("Backspace", lambda: tap("\b"), "teh"),
        ("space", lambda: tap(" "), "teh "),
        ("teh + space again", lambda: (tap("teh"), d.wait(TYPING_S), tap(" ")), "teh teh "),
    ]
    for name, act, want in checks:
        act()
        d.wait(SETTLE_S)
        now = text()
        got = now[len(start):] if now.startswith(start) else f"<changed: {now[-30:]!r}>"
        good = got == want
        ok += good
        print(f"{'ok ' if good else 'BAD'} {name:18} -> {got!r} (want {want!r})")

    subprocess.run(["gdbus", "call", "--session", "-d", "io.github.nextkeybor.Daemon",
                    "-o", "/io/github/nextkeybor/Daemon", "-m", "io.github.nextkeybor.Daemon.ForgetWord", "teh"],
                   env={**os.environ, "DBUS_SESSION_BUS_ADDRESS": bus}, check=False, capture_output=True)
    print(f"{ok}/{len(checks)} checks passed")
    sys.exit(0 if ok == len(checks) else 1)


if __name__ == "__main__":
    main()
