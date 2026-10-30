// Swipe (gesture) typing on the stock OSK: slide a finger across the letter
// keys, a grey trail follows it, and on lift the path goes to the daemon to
// be matched against the dictionary.
//
// Touches are watched from keyboardBox, an ancestor of the keyboard, so we
// see them before the keys and before other extensions listening on the
// keyboard itself (TouchUp's swipe-down-to-close reacts after 25px, well
// before a swipe is recognised). Keys only act on begin/end, so swallowing
// the moves of a touch that started on a letter costs them nothing; begin
// and end always go through.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// A press on a letter becomes a swipe once the finger has travelled this far
// (in key widths) and left the key by this margin, so fast taps that drift a
// little stay taps.
const START_DISTANCE = 0.75;
const START_MARGIN = 0.2;
const GAP_REACH = 0.25;
const TRAIL_LIFETIME_MS = 280;
const TRAIL_WIDTH = 6;
const LETTER = /^\p{L}$/u;

// The stock Key (a St.BoxLayout) around a letter key button, or null.
function letterKeyOf(actor) {
    const key = actor?.get_parent();
    if (!key || key.keyButton !== actor || typeof key.cancel !== 'function')
        return null;
    return LETTER.test(actor.get_label() ?? '') ? key : null;
}

function allLetterButtons(root, out = []) {
    for (const child of root.get_children()) {
        if (!child.mapped)
            continue;
        if (child instanceof St.Button && letterKeyOf(child))
            out.push(child);
        else
            allLetterButtons(child, out);
    }
    return out;
}

// Centres of the letter keys on screen, {"q": [x, y], ...}, in key widths
// so the daemon's radii mean "keys"; null when no letters are showing.
export function letterKeyCentres(keyboard) {
    const buttons = allLetterButtons(keyboard);
    if (buttons.length === 0)
        return null;
    const widths = buttons.map(b => b.get_transformed_size()[0]).sort((a, b) => a - b);
    const unit = widths[Math.floor(widths.length / 2)] || 1;
    const keys = {};
    for (const b of buttons) {
        const [bx, by] = b.get_transformed_position();
        const [bw, bh] = b.get_transformed_size();
        keys[b.get_label().toLowerCase()] = [(bx + bw / 2) / unit, (by + bh / 2) / unit];
    }
    return {keys, unit};
}

class Trail {
    constructor() {
        this._points = []; // [x, y, time] in stage coordinates
        this._ended = false;
        this._area = new St.DrawingArea({reactive: false});
        this._area.set_size(global.stage.width, global.stage.height);
        this._area.connect('repaint', area => this._repaint(area));
        Main.layoutManager.uiGroup.add_child(this._area);

        // Redraw every frame so the tail keeps fading while the finger rests.
        this._timeline = new Clutter.Timeline({actor: this._area, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    add(x, y) {
        this._points.push([x, y, Date.now()]);
    }

    // Let the rest of the tail fade out, then go away.
    end() {
        this._ended = true;
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        this._area?.destroy();
        this._area = null;
    }

    _tick() {
        const cutoff = Date.now() - TRAIL_LIFETIME_MS;
        while (this._points.length > 1 && this._points[1][2] < cutoff)
            this._points.shift();
        if (this._ended && (this._points.length === 0 || this._points[this._points.length - 1][2] < cutoff)) {
            this.destroy();
            return;
        }
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const now = Date.now();
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        const pts = this._points;
        for (let i = 1; i < pts.length; i++) {
            const age = Math.min(1, (now - pts[i][2]) / TRAIL_LIFETIME_MS);
            const fade = 1 - age;
            if (fade <= 0)
                continue;
            cr.setSourceRGBA(0.75, 0.75, 0.78, 0.85 * fade);
            cr.setLineWidth(TRAIL_WIDTH * scale * (0.35 + 0.65 * fade));
            cr.moveTo(pts[i - 1][0], pts[i - 1][1]);
            cr.lineTo(pts[i][0], pts[i][1]);
            cr.stroke();
        }
        cr.$dispose();
    }
}

export class SwipeTyper {
    // onSwipe(keys, path, shifted) gets letter centres and the finger path in
    // key-width units (path points are [x, y, milliseconds since the touch
    // began]), and whether the keyboard showed capitals.
    constructor(keyboard, {enabled, onSwipe}) {
        this._kb = keyboard;
        this._enabled = enabled;
        this._onSwipe = onSwipe;
        this._reset();
        this._eventId = Main.layoutManager.keyboardBox.connect('captured-event',
            (_a, event) => this._onEvent(event));
    }

    destroy() {
        Main.layoutManager.keyboardBox.disconnect(this._eventId);
        this._trail?.destroy();
        this._reset();
    }

    // Drop the touch being watched, if any (its key is going away).
    reset() {
        this._reset();
    }

    _reset() {
        this._slot = null;
        this._key = null;
        this._points = [];
        this._swiping = false;
        this._trail?.end();
        this._trail = null;
    }

    _onEvent(event) {
        const T = Clutter.EventType;
        const type = event.type();
        if (type !== T.TOUCH_BEGIN && type !== T.TOUCH_UPDATE &&
            type !== T.TOUCH_END && type !== T.TOUCH_CANCEL)
            return Clutter.EVENT_PROPAGATE;

        // Compare slots: each event wraps its sequence in a new JS object.
        const slot = event.get_event_sequence()?.get_slot() ?? -1;
        const [x, y] = event.get_coords();
        const time = event.get_time();

        if (type === T.TOUCH_BEGIN) {
            if (this._slot !== null || !this._enabled())
                return Clutter.EVENT_PROPAGATE;
            // A finger often lands in the gap between keys: a swipe may
            // start there too, from the nearest letter key (but not from
            // another key, such as backspace, which has slides of its own).
            const actor = global.stage.get_event_actor(event);
            const pressed = letterKeyOf(actor);
            const onKey = actor?.get_parent()?.keyButton === actor;
            const key = pressed ?? (onKey ? null : this._nearestLetterKey(x, y));
            if (key && this._kb.contains(key)) {
                this._slot = slot;
                this._key = key;
                this._keyPressed = !!pressed;
                this._points = [[x, y, time]];
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (this._slot === null || slot !== this._slot)
            return Clutter.EVENT_PROPAGATE;

        if (type === T.TOUCH_CANCEL) {
            this._reset();
            return Clutter.EVENT_PROPAGATE;
        }

        this._points.push([x, y, time]);
        if (type === T.TOUCH_UPDATE) {
            if (!this._swiping)
                this._maybeStart(x, y);
            else
                this._trail?.add(x, y);
            return Clutter.EVENT_STOP;
        }

        // TOUCH_END: a plain tap goes on to the key as usual.
        if (!this._swiping) {
            this._reset();
            return Clutter.EVENT_PROPAGATE;
        }
        this._finish();
        // Let the end through: the first key's press was cancelled, so the
        // key ignores it, and other listeners (TouchUp's keyboard gestures)
        // must see the touch end or they keep stale state, which crashed
        // GNOME Shell once they used a key destroyed since.
        return Clutter.EVENT_PROPAGATE;
    }

    _maybeStart(x, y) {
        const key = this._key;
        // Long-press already opened the extra characters popup: leave it be.
        if (this._keyPressed && key._pressTimeoutId === 0)
            return;
        const [kx, ky] = key.keyButton.get_transformed_position();
        const [width, height] = key.keyButton.get_transformed_size();
        const [x0, y0] = this._points[0];
        if (!width || Math.hypot(x - x0, y - y0) < START_DISTANCE * width)
            return;
        const margin = START_MARGIN * width;
        if (x > kx - margin && x < kx + width + margin && y > ky - margin && y < ky + height + margin)
            return;

        this._swiping = true;
        // Undo the press on the first key without typing it.
        if (this._keyPressed) {
            key.cancel();
            key._pressed = false;
            key.keyButton.remove_style_pseudo_class('active');
            key.emit('released');
        }

        this._trail = new Trail();
        for (const [px, py] of this._points)
            this._trail.add(px, py);
    }

    // The letter key within GAP_REACH key widths of (x, y), for touches that
    // land between keys; null elsewhere (other keys, toolbar, panels).
    _nearestLetterKey(x, y) {
        let best = null, bestDistance = Infinity;
        for (const button of allLetterButtons(this._kb)) {
            const [bx, by] = button.get_transformed_position();
            const [bw, bh] = button.get_transformed_size();
            const dx = Math.max(bx - x, 0, x - (bx + bw));
            const dy = Math.max(by - y, 0, y - (by + bh));
            const distance = Math.hypot(dx, dy);
            if (distance < bestDistance && distance <= GAP_REACH * bw) {
                best = button;
                bestDistance = distance;
            }
        }
        return best?.get_parent() ?? null;
    }

    _finish() {
        const layout = letterKeyCentres(this._kb);
        const shifted = this._kb._currentPage === this._kb._layers?.['shift'];
        const points = this._points;
        this._reset();
        if (!layout)
            return;
        const {keys, unit} = layout;
        const t0 = points[0][2];
        const path = points.map(([px, py, t]) => [px / unit, py / unit, t - t0]);
        this._onSwipe(keys, path, shifted);
    }
}
