#include "speech.h"

#include <algorithm>
#include <cstring>
#include <cmath>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

#include <csignal>
#include <glib-unix.h>
#include <glib/gstdio.h>
#include <sys/wait.h>
#include <unistd.h>

#include <whisper.h>

#include "dbus_service.h"

namespace nkb::speech {

namespace {

constexpr int kRate = 16000;
constexpr double kLevelInterval = 0.1;       // seconds between DictationLevel signals
constexpr double kSilenceStopAfter = 1.8;    // seconds of quiet after speech
constexpr double kSpeechLevel = 0.35;        // level (0..1) that counts as speech

struct ModelInfo {
    const char *name;
    int size_mb;
    bool multilingual;
};

const ModelInfo kModels[] = {
    {"tiny", 75, true},        {"tiny.en", 75, false},
    {"base", 142, true},       {"base.en", 142, false},
    {"small", 466, true},      {"small.en", 466, false},
    {"medium", 1500, true},    {"medium.en", 1500, false},
    {"large-v3-turbo-q5_0", 547, true}, {"large-v3-turbo", 1620, true},
    {"large-v3", 3100, true},
};

std::string model_path(const std::string &name) {
    return join_path(data_dir("models"), "ggml-" + name + ".bin");
}

bool known_model(const std::string &name) {
    return std::any_of(std::begin(kModels), std::end(kModels),
                       [&](const ModelInfo &m) { return name == m.name; });
}

// ---- whisper context (worker threads only) ----

std::mutex g_ctx_mutex;
whisper_context *g_ctx = nullptr;
std::string g_ctx_model;

std::mutex g_download_mutex;
std::set<std::string> g_downloading;

// Blocking; returns an error message or "".
std::string ensure_model(const std::string &name) {
    std::string path = model_path(name);
    if (file_exists(path))
        return "";
    {
        std::lock_guard lock(g_download_mutex);
        if (g_downloading.count(name))
            return "model " + name + " is still downloading";
        g_downloading.insert(name);
    }
    std::string what = "model:" + name;
    double last = -1;
    auto r = http_download(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-" + name + ".bin", path,
        [what, &last](double f) {
            if (f - last < 0.01 && f < 1.0)
                return;
            last = f;
            run_on_main([what, f] {
                Service::get().emit("DownloadProgress", g_variant_new("(sd)", what.c_str(), f));
            });
        });
    {
        std::lock_guard lock(g_download_mutex);
        g_downloading.erase(name);
    }
    std::string msg = r.ok() ? "" : "download failed: " + r.error;
    run_on_main([what, msg] {
        Service::get().emit("DownloadFinished",
                            g_variant_new("(sbs)", what.c_str(), msg.empty(), msg.c_str()));
    });
    return msg;
}

whisper_context *context_for(const std::string &name, std::string &error) {
    // Caller holds g_ctx_mutex.
    if (g_ctx && g_ctx_model == name)
        return g_ctx;
    error = ensure_model(name);
    if (!error.empty())
        return nullptr;
    if (g_ctx) {
        whisper_free(g_ctx);
        g_ctx = nullptr;
    }
    whisper_context_params cp = whisper_context_default_params();
    g_ctx = whisper_init_from_file_with_params(model_path(name).c_str(), cp);
    if (!g_ctx) {
        error = "could not load model " + name;
        return nullptr;
    }
    g_ctx_model = name;
    return g_ctx;
}

std::string transcribe(const std::vector<float> &pcm, const std::string &language,
                       std::string &detected, std::string &error) {
    std::lock_guard lock(g_ctx_mutex);
    std::string model = setting_string("speech-model", "base");
    whisper_context *ctx = context_for(model, error);
    if (!ctx)
        return "";

    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    int threads = setting_int("speech-threads", 0);
    if (threads <= 0)
        threads = static_cast<int>(std::clamp(std::thread::hardware_concurrency(), 1u, 8u));
    p.n_threads = threads;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_timestamps = false;
    p.print_special = false;
    p.no_timestamps = true;
    p.translate = false;
    p.suppress_blank = true;
    p.suppress_nst = true;  // no "(music)" style non-speech tokens
    p.language = language.c_str();
    p.detect_language = false;

    if (whisper_full(ctx, p, pcm.data(), static_cast<int>(pcm.size())) != 0) {
        error = "transcription failed";
        return "";
    }
    std::string text;
    for (int i = 0; i < whisper_full_n_segments(ctx); i++) {
        std::string seg = trim(whisper_full_get_segment_text(ctx, i));
        // Drop whole-segment annotations such as [BLANK_AUDIO] or (silence).
        if (seg.size() >= 2 && ((seg.front() == '[' && seg.back() == ']') ||
                                (seg.front() == '(' && seg.back() == ')') ||
                                (seg.front() == '*' && seg.back() == '*')))
            continue;
        if (!text.empty() && !seg.empty())
            text += ' ';
        text += seg;
    }
    int lang_id = whisper_full_lang_id(ctx);
    detected = lang_id >= 0 ? whisper_lang_str(lang_id) : language;
    return trim(text);
}

// ---- GroqType (optional) ----
//
// github.com/dixonSolutions/GroqType: cloud transcription with Groq's
// Whisper through `groqtype transcribe FILE`, with its own config and API
// key. Used when installed and configured, unless speech-engine says
// otherwise; local whisper.cpp stays the fallback.

std::string groqtype_path() {
    gchar *found = g_find_program_in_path("groqtype");
    std::string path = found ? found : "";
    g_free(found);
    if (path.empty()) {
        // The user service's PATH may lack ~/.local/bin, where GroqType installs.
        std::string local = join_path(join_path(g_get_home_dir(), ".local/bin"), "groqtype");
        if (g_file_test(local.c_str(), G_FILE_TEST_IS_EXECUTABLE))
            path = local;
    }
    return path;
}

bool groqtype_has_key() {
    if (const char *env = g_getenv("GROQ_API_KEY"); env && *env)
        return true;
    const char *override = g_getenv("GROQTYPE_CONFIG");
    std::string config = override && *override
        ? override : join_path(join_path(g_get_user_config_dir(), "groqtype"), "config.json");
    std::string text;
    if (!read_file(config, text))
        return false;
    try {
        return !json::parse(text).value("api_key", "").empty();
    } catch (...) {
        return false;
    }
}

// "groqtype" or "whisper", from the speech-engine setting.
std::string engine() {
    std::string want = setting_string("speech-engine", "auto");
    if (want == "whisper")
        return "whisper";
    if (want == "groqtype")
        return "groqtype";
    return !groqtype_path().empty() && groqtype_has_key() ? "groqtype" : "whisper";
}

bool write_wav(const std::string &path, const std::vector<float> &pcm) {
    std::string out;
    auto u32 = [&out](uint32_t v) { out.append(reinterpret_cast<const char *>(&v), 4); };
    auto u16 = [&out](uint16_t v) { out.append(reinterpret_cast<const char *>(&v), 2); };
    uint32_t bytes = static_cast<uint32_t>(pcm.size() * 2);
    out += "RIFF";
    u32(36 + bytes);
    out += "WAVEfmt ";
    u32(16);
    u16(1);  // PCM
    u16(1);  // mono
    u32(kRate);
    u32(kRate * 2);
    u16(2);
    u16(16);
    out += "data";
    u32(bytes);
    for (float f : pcm)
        u16(static_cast<uint16_t>(static_cast<int16_t>(std::lround(std::clamp(f, -1.0f, 1.0f) * 32767.0f))));
    return g_file_set_contents(path.c_str(), out.data(), static_cast<gssize>(out.size()), nullptr);
}

std::string transcribe_groqtype(const std::vector<float> &pcm, const std::string &language, std::string &error) {
    std::string program = groqtype_path();
    if (program.empty()) {
        error = "GroqType is not installed";
        return "";
    }
    std::string wav = join_path(g_get_user_runtime_dir(), "nextkeybor-dictation-" + random_id() + ".wav");
    if (!write_wav(wav, pcm)) {
        error = "cannot write " + wav;
        return "";
    }
    const gchar *argv[] = {program.c_str(), "transcribe", wav.c_str(), "--language", language.c_str(), nullptr};
    gchar *out = nullptr, *err = nullptr;
    gint status = 0;
    GError *gerr = nullptr;
    bool ran = g_spawn_sync(nullptr, const_cast<gchar **>(argv), nullptr, G_SPAWN_DEFAULT, nullptr, nullptr,
                            &out, &err, &status, &gerr);
    g_unlink(wav.c_str());
    std::string text = out ? out : "", message = err ? trim(err) : "";
    g_free(out);
    g_free(err);
    if (!ran) {
        error = std::string("cannot run groqtype: ") + gerr->message;
        g_error_free(gerr);
        return "";
    }
    if (!g_spawn_check_wait_status(status, nullptr)) {
        error = message.empty() ? "groqtype failed" : message;
        return "";
    }
    return trim(text);
}

// ---- recording (main thread) ----

struct Session {
    std::string id;
    std::string language;
    GPid pid = 0;
    int fd = -1;
    guint watch = 0;
    guint timeout = 0;
    std::vector<float> pcm;
    std::string partial;      // bytes of an incomplete float
    size_t level_samples = 0;
    double level_sum = 0;
    bool heard_speech = false;
    double quiet_seconds = 0;
    bool transcribing = false;
};

Session *g_session = nullptr;
// The shell connection that started the latest dictation: what is said goes
// to it alone, not to every client on the bus.
std::string g_client;

void emit_dictation(const char *signal, GVariant *params) {
    Service::get().emit(signal, params, g_client);
}

void emit_state(const std::string &id, const char *state) {
    emit_dictation("DictationState", g_variant_new("(ss)", id.c_str(), state));
}

void emit_error(const std::string &id, const std::string &msg) {
    emit_dictation("DictationError", g_variant_new("(ss)", id.c_str(), msg.c_str()));
}

void stop_capture(Session *s) {
    if (s->watch) {
        g_source_remove(s->watch);
        s->watch = 0;
    }
    if (s->timeout) {
        g_source_remove(s->timeout);
        s->timeout = 0;
    }
    if (s->pid > 0) {
        kill(s->pid, SIGTERM);
        GPid pid = s->pid;
        g_child_watch_add(pid, [](GPid p, gint, gpointer) { g_spawn_close_pid(p); }, nullptr);
        s->pid = 0;
    }
    if (s->fd >= 0) {
        close(s->fd);
        s->fd = -1;
    }
}

void finish_session(bool transcribe_it);

void on_samples(Session *s, const float *data, size_t n) {
    s->pcm.insert(s->pcm.end(), data, data + n);
    for (size_t i = 0; i < n; i++) {
        s->level_sum += static_cast<double>(data[i]) * data[i];
        s->level_samples++;
        if (s->level_samples >= kRate * kLevelInterval) {
            double rms = std::sqrt(s->level_sum / static_cast<double>(s->level_samples));
            double db = 20.0 * std::log10(std::max(rms, 1e-6));
            double level = std::clamp((db + 60.0) / 60.0, 0.0, 1.0);
            s->level_samples = 0;
            s->level_sum = 0;
            emit_dictation("DictationLevel", g_variant_new("(d)", level));
            if (level >= kSpeechLevel) {
                s->heard_speech = true;
                s->quiet_seconds = 0;
            } else if (s->heard_speech) {
                s->quiet_seconds += kLevelInterval;
            }
        }
    }
}

gboolean on_readable(gint fd, GIOCondition cond, gpointer) {
    Session *s = g_session;
    if (!s || s->fd != fd)
        return G_SOURCE_REMOVE;
    if (cond & G_IO_IN) {
        char buf[16384];
        ssize_t n = read(fd, buf, sizeof buf);
        if (n > 0) {
            s->partial.append(buf, static_cast<size_t>(n));
            size_t whole = s->partial.size() / sizeof(float) * sizeof(float);
            on_samples(s, reinterpret_cast<const float *>(s->partial.data()), whole / sizeof(float));
            s->partial.erase(0, whole);

            if (setting_bool("speech-silence-stop", true) && s->heard_speech &&
                s->quiet_seconds >= kSilenceStopAfter) {
                s->watch = 0;
                finish_session(true);
                return G_SOURCE_REMOVE;
            }
            double max_s = setting_int("speech-max-seconds", 120);
            if (static_cast<double>(s->pcm.size()) / kRate >= max_s) {
                s->watch = 0;
                finish_session(true);
                return G_SOURCE_REMOVE;
            }
            return G_SOURCE_CONTINUE;
        }
    }
    // EOF or error: the recorder died.
    s->watch = 0;
    finish_session(s->pcm.size() > kRate / 2);
    return G_SOURCE_REMOVE;
}

bool spawn_recorder(Session *s, std::string &error) {
    const char *pw[] = {"pw-record", "--raw", "--rate", "16000", "--channels", "1",
                        "--format", "f32", "--latency", "50ms", "-", nullptr};
    const char *pa[] = {"parecord", "--raw", "--latency-msec=50", "--format=float32le",
                        "--rate=16000", "--channels=1", nullptr};
    for (const char *const *argv : {pw, pa}) {
        GError *err = nullptr;
        gchar *prog = g_find_program_in_path(argv[0]);
        if (!prog)
            continue;
        g_free(prog);
        if (g_spawn_async_with_pipes(nullptr, const_cast<gchar **>(argv), nullptr,
                                     static_cast<GSpawnFlags>(G_SPAWN_SEARCH_PATH |
                                                              G_SPAWN_DO_NOT_REAP_CHILD |
                                                              G_SPAWN_STDERR_TO_DEV_NULL),
                                     nullptr, nullptr, &s->pid, nullptr, &s->fd, nullptr, &err)) {
            g_unix_set_fd_nonblocking(s->fd, TRUE, nullptr);
            return true;
        }
        error = err->message;
        g_error_free(err);
    }
    if (error.empty())
        error = "neither pw-record nor parecord is installed";
    return false;
}

void finish_session(bool transcribe_it) {
    Session *s = g_session;
    if (!s || s->transcribing)
        return;
    stop_capture(s);
    if (!transcribe_it || s->pcm.size() < kRate / 4) {
        emit_state(s->id, "idle");
        if (transcribe_it)
            emit_dictation("DictationResult",
                                g_variant_new("(sss)", s->id.c_str(), "", s->language.c_str()));
        delete s;
        g_session = nullptr;
        return;
    }
    s->transcribing = true;
    emit_state(s->id, "transcribing");

    std::string id = s->id, lang = s->language;
    auto pcm = std::make_shared<std::vector<float>>(std::move(s->pcm));
    delete s;
    g_session = nullptr;

    run_in_worker([id, lang, pcm] {
        std::string detected, error, text;
        if (engine() == "groqtype") {
            text = transcribe_groqtype(*pcm, lang, error);
            detected = lang;
            // Offline or out of quota: fall back to the local model if present.
            if (!error.empty() && file_exists(model_path(setting_string("speech-model", "base")))) {
                g_message("groqtype: %s; using whisper.cpp", error.c_str());
                error.clear();
                text = transcribe(*pcm, lang, detected, error);
            }
        } else {
            text = transcribe(*pcm, lang, detected, error);
        }
        run_on_main([id, text, detected, error] {
            if (!error.empty())
                emit_error(id, error);
            else
                emit_dictation("DictationResult", g_variant_new("(sss)", id.c_str(),
                                                                     text.c_str(), detected.c_str()));
            emit_state(id, "idle");
        });
    });
}

std::string start(std::string language, const std::string &client) {
    g_client = client;
    if (g_session)
        finish_session(false);
    if (language.empty())
        language = setting_string("speech-language", "auto");

    auto *s = new Session;
    s->id = random_id();
    s->language = language;
    std::string error;
    if (!spawn_recorder(s, error)) {
        emit_error(s->id, "cannot record audio: " + error);
        std::string id = s->id;
        delete s;
        return id;
    }
    g_session = s;
    s->watch = g_unix_fd_add(s->fd, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR),
                             on_readable, nullptr);
    emit_state(s->id, "recording");

    // Load the model while the user speaks so transcription starts immediately
    // (unless GroqType transcribes; no model download for nothing).
    if (engine() == "whisper") {
        run_in_worker([] {
            std::lock_guard lock(g_ctx_mutex);
            std::string err;
            context_for(setting_string("speech-model", "base"), err);
        });
    }
    return s->id;
}

std::string capitalize(const char *s) {
    std::string out = s;
    if (!out.empty())
        out[0] = static_cast<char>(g_ascii_toupper(out[0]));
    return out;
}

}  // namespace

int transcribe_file(const std::string &path, const std::string &language) {
    whisper_log_set([](ggml_log_level, const char *, void *) {}, nullptr);
    std::string data;
    if (!read_file(path, data)) {
        g_printerr("cannot read %s\n", path.c_str());
        return 1;
    }
    std::vector<float> pcm;
    size_t chunk = data.find("data");
    if (data.compare(0, 4, "RIFF") == 0 && chunk != std::string::npos && chunk + 8 <= data.size()) {
        for (size_t i = chunk + 8; i + 1 < data.size(); i += 2) {
            int16_t v;
            memcpy(&v, data.data() + i, 2);
            pcm.push_back(static_cast<float>(v) / 32768.0f);
        }
    } else {
        pcm.resize(data.size() / sizeof(float));
        memcpy(pcm.data(), data.data(), pcm.size() * sizeof(float));
    }
    std::string detected, error;
    std::string text = transcribe(pcm, language.empty() ? "auto" : language, detected, error);
    if (!error.empty()) {
        g_printerr("%s\n", error.c_str());
        return 1;
    }
    g_print("[%s] %s\n", detected.c_str(), text.c_str());
    return 0;
}

bool is_recording() {
    return g_session && !g_session->transcribing;
}

json status() {
    std::string model = setting_string("speech-model", "base");
    return {{"model", model},
            {"model_ready", file_exists(model_path(model))},
            {"engine", engine()},
            {"groqtype_installed", !groqtype_path().empty()},
            {"groqtype_key", groqtype_has_key()},
            {"recording", is_recording()},
            {"language", setting_string("speech-language", "auto")}};
}

void init() {
    whisper_log_set([](ggml_log_level, const char *, void *) {}, nullptr);
    auto &svc = Service::get();

    svc.on("StartDictation", [](GVariant *params, GDBusMethodInvocation *inv) {
        if (!Service::get().caller_is_shell(inv)) {
            reply_error(inv, "only GNOME Shell may use the microphone through NextKeyBor");
            return;
        }
        const gchar *lang;
        g_variant_get(params, "(&s)", &lang);
        if (*lang && !valid_language_code(lang)) {
            reply_error(inv, "invalid language code");
            return;
        }
        reply_string(inv, start(lang, g_dbus_method_invocation_get_sender(inv)));
    });
    svc.on("StopDictation", [](GVariant *params, GDBusMethodInvocation *inv) {
        if (!Service::get().caller_is_shell(inv)) {
            reply_error(inv, "only GNOME Shell may use the microphone through NextKeyBor");
            return;
        }
        const gchar *id;
        g_variant_get(params, "(&s)", &id);
        if (g_session && (!*id || g_session->id == id))
            finish_session(true);
        reply_empty(inv);
    });
    svc.on("CancelDictation", [](GVariant *params, GDBusMethodInvocation *inv) {
        if (!Service::get().caller_is_shell(inv)) {
            reply_error(inv, "only GNOME Shell may use the microphone through NextKeyBor");
            return;
        }
        const gchar *id;
        g_variant_get(params, "(&s)", &id);
        if (g_session && (!*id || g_session->id == id))
            finish_session(false);
        reply_empty(inv);
    });
    svc.on("ListSpeechLanguages", [](GVariant *, GDBusMethodInvocation *inv) {
        json out = json::array({{{"code", "auto"}, {"name", "Detect automatically"}}});
        for (int i = 0; i <= whisper_lang_max_id(); i++)
            out.push_back({{"code", whisper_lang_str(i)},
                           {"name", capitalize(whisper_lang_str_full(i))}});
        reply_string(inv, out.dump());
    });
    svc.on("ListSpeechModels", [](GVariant *, GDBusMethodInvocation *inv) {
        std::string active = setting_string("speech-model", "base");
        json out = json::array();
        for (const auto &m : kModels)
            out.push_back({{"name", m.name},
                           {"size_mb", m.size_mb},
                           {"installed", file_exists(model_path(m.name))},
                           {"multilingual", m.multilingual},
                           {"active", active == m.name}});
        reply_string(inv, out.dump());
    });
    svc.on("DownloadSpeechModel", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *name;
        g_variant_get(params, "(&s)", &name);
        if (!known_model(name)) {
            reply_error(inv, std::string("unknown model ") + name);
            return;
        }
        std::string n = name;
        run_in_worker([n] { ensure_model(n); });
        reply_empty(inv);
    });
}

}  // namespace nkb::speech
