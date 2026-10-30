#!/usr/bin/env python3
"""Make a swipe-typing test set of human-like finger paths for nextkeybord --swipe-bench.

    tools/swipe_bench.py [--count N] [--seed S] [--clean] [--words FILE] > swipes.jsonl
    nextkeybord --swipe-bench swipes.jsonl

Real fingers do not draw straight lines through key centres: they aim a
little off each key, round the corners (often passing well inside them),
overshoot the last letter and slow down at sharp turns. Each line is
{"word", "keys", "path"} with keys and path in key-width units and path
points as [x, y, t_ms]. Key rows are spaced 0.9 to 1.5 key widths apart,
covering landscape and portrait keyboards. --clean gives the old straight
paths through key centres, for comparison.
"""
import json
import math
import random
import sys
from pathlib import Path

ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
ROW_OFFSETS = [0.0, 0.5, 1.0]  # the stock GNOME layout's row shifts, in keys

# Common words that a swipe matcher must get right, whatever the sample.
CORE = ("the and you that this with have from what about would there their think going really "
        "people because thanks great today keyboard typing world hello good know love time when "
        "where which could should little before after something nothing tomorrow minute please "
        "quick question school student microbiology teacher class water friend family house "
        "maybe yes not now new was were they them then than our out "
        "Reddit YouTube TikTok").split()


def key_centres(row_step):
    return {c: (ROW_OFFSETS[r] + i + 0.5, r * row_step + 0.5)
            for r, letters in enumerate(ROWS) for i, c in enumerate(letters)}


def letter_targets(word, keys):
    """Key centres in order, with repeated letters as one stop."""
    pts = []
    for c in word.lower():
        k = keys[c]
        if not pts or pts[-1] != k:
            pts.append(k)
    return pts


def _curve(ctrl, cut, n):
    """Through the targets (cut=0, Catmull-Rom) or rounding them off (cut=1, B-spline)."""
    p = [ctrl[0]] + ctrl + [ctrl[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            cr = [0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2
                         + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3) for d in (0, 1)]
            b0, b1, b2, b3 = (1 - t) ** 3 / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6
            bs = [b0 * p0[d] + b1 * p1[d] + b2 * p2[d] + b3 * p3[d] for d in (0, 1)]
            out.append(tuple((1 - cut) * cr[d] + cut * bs[d] for d in (0, 1)))
    out.append(ctrl[-1])
    return out


def human_path(targets, rng):
    """A finger path for these key centres: [(x, y, t_ms), ...]."""
    if len(targets) == 1:  # a single key, or double letters only: a little loop
        x, y = targets[0]
        targets = [(x, y), (x + 0.3, y + 0.3), (x, y)]
    ox, oy = rng.gauss(0, 0.15), rng.gauss(0, 0.2)
    aim = [(x + ox + rng.gauss(0, 0.2), y + oy + rng.gauss(0, 0.25)) for x, y in targets]
    # Begin a little before the first key and run on past the last.
    (ax, ay), (bx, by) = aim[0], aim[1]
    lead = rng.uniform(0, 0.25)
    d = math.hypot(bx - ax, by - ay) or 1
    aim.insert(0, (ax - (bx - ax) / d * lead, ay - (by - ay) / d * lead))
    (ax, ay), (bx, by) = aim[-2], aim[-1]
    over = rng.uniform(0, 0.45)
    d = math.hypot(bx - ax, by - ay) or 1
    aim.append((bx + (bx - ax) / d * over, by + (by - ay) / d * over))

    # Round gentle corners off a lot, but reach for the key on sharp turns
    # and reversals ("o-m-o" in "tomorrow"), as fingers do.
    cut = rng.uniform(0.2, 0.6)
    rounded = [aim[0]]
    for i in range(1, len(aim) - 1):
        (px, py), (x, y), (nx, ny) = aim[i - 1], aim[i], aim[i + 1]
        v1, v2 = (x - px, y - py), (nx - x, ny - y)
        n1, n2 = math.hypot(*v1), math.hypot(*v2)
        sharp = 0.0
        if n1 > 1e-9 and n2 > 1e-9:
            sharp = math.acos(max(-1, min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))) / math.pi
        pull = cut * (1 - sharp) ** 2
        rounded.append((x + pull * ((px + nx) / 2 - x), y + pull * ((py + ny) / 2 - y)))
    rounded.append(aim[-1])
    dense = _curve(rounded, 0.0, 24)
    # Walk the curve at finger speed (keys per second), slower on tight bends,
    # sampling at 60 Hz like touchscreen events.
    speed = rng.uniform(6, 12)
    out, t, acc = [dense[0]], 0.0, 0.0
    times = [0.0]
    for i in range(1, len(dense)):
        seg = math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1])
        bend = 0.0
        if i + 1 < len(dense):
            v1 = (dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1])
            v2 = (dense[i + 1][0] - dense[i][0], dense[i + 1][1] - dense[i][1])
            n1, n2 = math.hypot(*v1), math.hypot(*v2)
            if n1 > 1e-9 and n2 > 1e-9:
                bend = math.acos(max(-1, min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2))))
        t += seg / (speed * (1 - 0.6 * min(1, bend / 0.5))) * 1000
        acc += seg
        if t - times[-1] >= 1000 / 60:
            out.append(dense[i])
            times.append(t)
    if out[-1] != dense[-1]:
        out.append(dense[-1])
        times.append(t)
    return [(x + rng.gauss(0, 0.02), y + rng.gauss(0, 0.02), round(ms)) for (x, y), ms in zip(out, times)]


def clean_path(targets, rng):
    if len(targets) == 1:
        x, y = targets[0]
        targets = [(x, y), (x + 0.15, y + 0.15)]
    return [(x + rng.gauss(0, 0.1), y + rng.gauss(0, 0.1), 0) for x, y in targets]


def sample_words(path, count, rng):
    words = []
    for line in Path(path).read_text().splitlines()[:6000]:
        w = line.split(" ")[0]
        if len(w) >= 2 and w.isascii() and w.isalpha() and w.islower():
            words.append(w)
    picked = [w for w in CORE]
    rest = [w for w in words if w not in picked]
    picked += rng.sample(rest, max(0, min(len(rest), count - len(picked))))
    return picked[:count]


def main():
    args = sys.argv[1:]
    count, seed, clean = 500, 1, False
    words_file = Path.home() / ".local/share/nextkeybor/wordfreq/en_50k.txt"
    while args:
        opt = args.pop(0)
        if opt == "--count":
            count = int(args.pop(0))
        elif opt == "--seed":
            seed = int(args.pop(0))
        elif opt == "--clean":
            clean = True
        elif opt == "--words":
            words_file = Path(args.pop(0))
        else:
            sys.exit(__doc__)
    rng = random.Random(seed)
    for word in sample_words(words_file, count, rng):
        keys = key_centres(rng.uniform(0.9, 1.5))
        targets = letter_targets(word, keys)
        pts = clean_path(targets, rng) if clean else human_path(targets, rng)
        print(json.dumps({
            "word": word,
            "keys": {c: [round(x, 3), round(y, 3)] for c, (x, y) in keys.items()},
            "path": [[round(x, 3), round(y, 3), t] for x, y, t in pts],
        }))


if __name__ == "__main__":
    main()
