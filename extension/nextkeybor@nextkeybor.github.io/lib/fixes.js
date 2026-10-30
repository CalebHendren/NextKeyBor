// Fixes for the stock GNOME Shell on-screen keyboard (supersede the
// osk-tap-fix@surface.local extension).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Terminals (VTE) and most Chromium/Qt fields report empty surrounding text,
// which the stock OSK reads as "start of the buffer" and so latches Shift
// after every backspace or key. Only auto-capitalize an empty buffer when the
// field was just focused, not right after the user typed into it.
export function updateLevelFromHints(userInputHappened) {
    if (this._latched)
        return;

    const hint = this._contentHint;
    const Hints = Clutter.InputContentHintFlags;
    if (hint & Hints.LOWERCASE) {
        this._setActiveLevel('default');
        return;
    }
    if (!this._layers['shift'])
        return;
    if (hint & Hints.UPPERCASE) {
        this._setActiveLevel('shift');
        return;
    }
    if (hint & (Hints.AUTO_CAPITALIZATION | Hints.TITLECASE)) {
        if (this._surroundingTextId)
            return;
        this._surroundingTextId = Main.inputMethod.connect('surrounding-text-set', () => {
            Main.inputMethod.disconnect(this._surroundingTextId);
            this._surroundingTextId = 0;

            const [text, cursor] = Main.inputMethod.getSurroundingText();
            if (!text || cursor === 0) {
                this._setActiveLevel(userInputHappened ? 'default' : 'shift');
                return;
            }
            const before = GLib.utf8_substring(text, 0, cursor);
            let shift;
            if (hint & Hints.TITLECASE)
                shift = before.endsWith(' ');
            else
                shift = /[.!?]\s+$/.test(before);
            this._setActiveLevel(shift ? 'shift' : 'default');
        });
        Main.inputMethod.request_surrounding();
        return;
    }
    if (userInputHappened && this._currentPage === this._layers['shift'])
        this._setActiveLevel('default');
}

// Closes the long-press popups (extra characters) of the keyboard's keys,
// and the language menu. A key with its popup open holds a stage-wide
// captured-event handler that stops every press outside the popup; when
// the keys are rebuilt under it, touches could stop reaching anything.
export function closeKeyPopups(keyboard) {
    const visit = actor => {
        for (const child of actor.get_children()) {
            if (child._boxPointer && typeof child._hideSubkeys === 'function') {
                child.cancel();
                child._hideSubkeys();
            } else {
                visit(child);
            }
        }
    };
    if (keyboard._currentLayout)
        visit(keyboard._currentLayout);
    keyboard._languagePopup?.close(false);
}

// The app sends text_input_v3.enable only after it has processed the tap, so
// look for the focused text input a little later, then again for slow apps
// and for Chromium, which drops and re-enables it while the tap settles.
const CHECK_DELAYS_MS = [120, 450, 1000];

const TOUCH_DEVICE_TYPES = [
    Clutter.InputDeviceType.TOUCHSCREEN_DEVICE,
    Clutter.InputDeviceType.TABLET_DEVICE,
    Clutter.InputDeviceType.PEN_DEVICE,
    Clutter.InputDeviceType.ERASER_DEVICE,
];

function windowActorFor(actor) {
    for (let a = actor; a; a = a.get_parent()) {
        if (a instanceof Meta.WindowActor)
            return a;
    }
    return null;
}

// Chromium never enables text-input-v3 inside its popups (extension popups
// such as Bitwarden's, the omnibox dropdown), so no text input ever gets
// focus there and the check below finds nothing. The popup does hold
// keyboard focus, so the OSK's plain key events still reach it: open the OSK
// on a tap in a browser popup anyway, and close it again with the popup.
//
// On Wayland those popups are usually not windows of their own but a
// subsurface of the browser window (a smaller surface actor next to the main
// one); other browsers and older versions use popup windows.
const POPUP_TYPES = [
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.MENU,
    Meta.WindowType.COMBO,
    Meta.WindowType.UTILITY,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];
const BROWSER_CLASS = /chrom|brave|vivaldi|edge|opera/i;
// A subsurface narrower than this share of the window is taken for a popup
// (web content and video overlays span most of it).
const POPUP_MAX_WIDTH = 0.7;

function isBrowser(window) {
    const classOf = w => `${w?.get_wm_class() ?? ''} ${w?.get_gtk_application_id() ?? ''} ${w?.get_sandboxed_app_id() ?? ''}`;
    return BROWSER_CLASS.test(classOf(window)) || BROWSER_CLASS.test(classOf(window?.get_transient_for()));
}

// The actor that goes away with the popup the tap landed in, or null.
function browserPopup(window, windowActor, eventActor) {
    if (!window || !isBrowser(window))
        return null;
    if (POPUP_TYPES.includes(window.get_window_type()))
        return windowActor;
    // MetaSurfaceActor is not in the typelib; go by the type name.
    const container = eventActor?.get_parent();
    if (!/^MetaSurfaceActor/.test(eventActor?.constructor.$gtype?.name ?? '') || !container ||
        eventActor === container.get_first_child())
        return null;
    return eventActor.width < windowActor.width * POPUP_MAX_WIDTH ? eventActor : null;
}

// Keyboard.open() normally waits a moment before showing, and a focus-out
// in that window cancels it; Chromium blurs and refocuses its text input
// around a tap, so show the keyboard straight away.
function openNow() {
    if (Main.keyboard.visible)
        return;
    Main.layoutManager.keyboardIndex = Main.layoutManager.focusIndex;
    Main.keyboard.keyboardActor?.open(true);
}

// Mutter only raises the OSK for text-input-v3 version 1 clients when they
// re-send enable on an already focused field, which GTK does on every tap but
// Chromium, Electron and Qt never do. Open it ourselves after a touch/pen tap
// on a window when a text input has focus.
export class TapFix {
    constructor() {
        this._timeouts = new Set();
        this._eventId = global.stage.connect('captured-event',
            (_stage, event) => this._onEvent(event));
    }

    destroy() {
        this._forgetPopup();
        global.stage.disconnect(this._eventId);
        this._eventId = 0;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
    }

    _onEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.TOUCH_END &&
            type !== Clutter.EventType.BUTTON_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        const deviceType = event.get_source_device()?.get_device_type();
        if (!TOUCH_DEVICE_TYPES.includes(deviceType))
            return Clutter.EVENT_PROPAGATE;

        const eventActor = global.stage.get_event_actor(event);
        const windowActor = windowActorFor(eventActor);
        const window = windowActor?.get_meta_window();
        if (!window)
            return Clutter.EVENT_PROPAGATE;
        const popup = browserPopup(window, windowActor, eventActor);

        CHECK_DELAYS_MS.forEach((delay, i) => {
            const last = i === CHECK_DELAYS_MS.length - 1;
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._timeouts.delete(id);
                if (!this._maybeOpen() && popup && last)
                    this._openForPopup(popup);
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        });
        return Clutter.EVENT_PROPAGATE;
    }

    // True when a text input has focus (the OSK is then open or opening).
    _maybeOpen() {
        // currentFocus is set by mutter's focus_in for a Wayland client's
        // enabled text input and cleared again on disable (blur).
        if (!Main.inputMethod.currentFocus)
            return false;
        openNow();
        return true;
    }

    // popup: the actor that is destroyed or unmapped when the popup closes.
    _openForPopup(popup) {
        openNow();
        if (this._popup === popup)
            return;
        this._forgetPopup();
        this._popup = popup;
        popup.connectObject(
            'destroy', () => this._onPopupGone(),
            'notify::mapped', () => {
                if (!popup.mapped)
                    this._onPopupGone();
            }, this);
    }

    _onPopupGone() {
        this._forgetPopup();
        if (!Main.inputMethod.currentFocus)
            Main.keyboard.close();
    }

    _forgetPopup() {
        this._popup?.disconnectObject(this);
        this._popup = null;
    }
}
