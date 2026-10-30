// Client for the nextkeybord D-Bus service.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'io.github.nextkeybor.Daemon';
const OBJECT_PATH = '/io/github/nextkeybor/Daemon';

const SIGNALS = [
    'DictationState', 'DictationLevel', 'DictationResult', 'DictationError',
    'MediaResults', 'MediaPreviewReady', 'MediaReady', 'MediaError',
    'OwnMediaChanged', 'FavoritesChanged', 'KeyboardStateChanged',
    'DownloadProgress', 'DownloadFinished',
];

function loadInterfaceXml(dir) {
    const file = dir.get_child('dbus').get_child(`${BUS_NAME}.xml`);
    const [, bytes] = file.load_contents(null);
    return new TextDecoder().decode(bytes);
}

function parseJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

// Emits 'available-changed' (bool) and one event per D-Bus signal, named
// after the signal, with the unpacked arguments.
export class DaemonClient extends Signals.EventEmitter {
    constructor(extensionDir) {
        super();
        const Proxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXml(extensionDir));
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._signalIds = [];
        this.available = false;

        // Flags: let D-Bus activation start the daemon on first call.
        new Proxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`NextKeyBor: cannot create daemon proxy: ${error.message}`);
                return;
            }
            this._proxy = proxy;
            for (const name of SIGNALS) {
                this._signalIds.push(proxy.connectSignal(name,
                    (_p, _sender, args) => this.emit(name, ...args)));
            }
            proxy.connectObject('notify::g-name-owner', () => this._syncOwner(), this);
            this._syncOwner();
            if (!this.available)
                this._poke();
        }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy) {
            for (const id of this._signalIds)
                this._proxy.disconnectSignal(id);
            this._proxy.disconnectObject(this);
        }
        this._signalIds = [];
        this._proxy = null;
        this.available = false;
    }

    // Try to D-Bus-activate the daemon once; notify::g-name-owner does the rest.
    _poke() {
        this._proxy?.GetStatusAsync().catch(() => {});
    }

    _syncOwner() {
        const available = !!this._proxy?.g_name_owner;
        if (available === this.available)
            return;
        this.available = available;
        this.emit('available-changed', available);
    }

    async _call(method, ...args) {
        if (!this._proxy)
            throw new Error('NextKeyBor daemon is not running');
        return this._proxy[`${method}Async`](...args);
    }

    async getStatus() {
        const [json] = await this._call('GetStatus');
        return parseJson(json, {});
    }

    // Speech
    async startDictation(language) {
        const [id] = await this._call('StartDictation', language);
        return id;
    }

    stopDictation(id) {
        return this._call('StopDictation', id);
    }

    cancelDictation(id) {
        return this._call('CancelDictation', id);
    }

    async listSpeechLanguages() {
        const [json] = await this._call('ListSpeechLanguages');
        return parseJson(json, []);
    }

    async listSpeechModels() {
        const [json] = await this._call('ListSpeechModels');
        return parseJson(json, []);
    }

    downloadSpeechModel(name) {
        return this._call('DownloadSpeechModel', name);
    }

    // Prediction
    async suggest(context, language, max) {
        const [words] = await this._call('Suggest', context, language, max);
        return words;
    }

    async autocorrect(context, language) {
        const [replacement] = await this._call('Autocorrect', context, language);
        return replacement;
    }

    setKeyLayout(keys) {
        return this._call('SetKeyLayout', JSON.stringify(keys));
    }

    acceptWord(word) {
        return this._call('AcceptWord', word);
    }

    async swipeWords(context, language, keys, path, max) {
        const [words] = await this._call('SwipeWords', context, language, keys, path, max);
        return words;
    }

    logSwipe(entry) {
        return this._call('LogSwipe', JSON.stringify(entry));
    }

    learnText(text, language) {
        return this._call('LearnText', text, language);
    }

    forgetWord(word) {
        return this._call('ForgetWord', word);
    }

    // Languages
    async listLanguages() {
        const [json] = await this._call('ListLanguages');
        return parseJson(json, []);
    }

    installLanguage(code) {
        return this._call('InstallLanguage', code);
    }

    setActiveLanguage(code) {
        return this._call('SetActiveLanguage', code);
    }

    // Emoji / symbols
    async searchEmoji(query, max) {
        const [json] = await this._call('SearchEmoji', query, max);
        return parseJson(json, []);
    }

    async emojiForWord(word) {
        const [emoji] = await this._call('EmojiForWord', word);
        return emoji;
    }

    noteEmojiUsed(emoji) {
        return this._call('NoteEmojiUsed', emoji);
    }

    async searchSymbols(query, max) {
        const [json] = await this._call('SearchSymbols', query, max);
        return parseJson(json, []);
    }

    // Media
    async searchMedia(kind, query, offset) {
        const [id] = await this._call('SearchMedia', kind, query, offset);
        return id;
    }

    async listFavorites(kind, query) {
        const [json] = await this._call('ListFavorites', kind, query);
        return parseJson(json, []);
    }

    async listOwnMedia(query) {
        const [json] = await this._call('ListOwnMedia', query);
        return parseJson(json, []);
    }

    setFavorite(item, favorite) {
        return this._call('SetFavorite', JSON.stringify(item), favorite);
    }

    importOwnMedia(paths = [], tags = '') {
        return this._call('ImportOwnMedia', paths, tags);
    }

    removeOwnMedia(id) {
        return this._call('RemoveOwnMedia', id);
    }

    async prepareMedia(item) {
        const [path, mime] = await this._call('PrepareMedia', JSON.stringify(item));
        return {path, mime};
    }

    async getKeyboardState() {
        const [json] = await this._call('GetKeyboardState');
        return parseJson(json, {});
    }
}

export {parseJson};

// Resolve when `signal` fires with a first argument equal to `key`, or reject
// after `timeoutMs`.
export function waitForSignal(emitter, signal, key, timeoutMs) {
    return new Promise((resolve, reject) => {
        let timeoutId = 0;
        const id = emitter.connect(signal, (_e, ...args) => {
            if (args[0] !== key)
                return;
            emitter.disconnect(id);
            GLib.source_remove(timeoutId);
            resolve(args);
        });
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            emitter.disconnect(id);
            reject(new Error(`timed out waiting for ${signal}`));
            return GLib.SOURCE_REMOVE;
        });
    });
}
