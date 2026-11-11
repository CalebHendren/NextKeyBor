#include "util.h"

#include <algorithm>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <mutex>
#include <random>
#include <sstream>
#include <thread>

#include <curl/curl.h>
#include <glib/gstdio.h>

namespace nkb {

namespace {

std::string ensure_dir(std::string path) {
    g_mkdir_with_parents(path.c_str(), 0700);
    return path;
}

}  // namespace

std::string join_path(const std::string &a, const std::string &b) {
    if (b.empty())
        return a;
    if (a.empty() || a.back() == '/')
        return a + b;
    return a + "/" + b;
}

std::string data_dir(const std::string &sub) {
    return ensure_dir(join_path(join_path(g_get_user_data_dir(), "nextkeybor"), sub));
}

std::string cache_dir(const std::string &sub) {
    return ensure_dir(join_path(join_path(g_get_user_cache_dir(), "nextkeybor"), sub));
}

bool file_exists(const std::string &path) {
    return g_file_test(path.c_str(), G_FILE_TEST_EXISTS);
}

bool read_file(const std::string &path, std::string &out) {
    std::ifstream in(path, std::ios::binary);
    if (!in)
        return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

bool write_file_atomic(const std::string &path, const std::string &data) {
    GError *err = nullptr;
    bool ok = g_file_set_contents(path.c_str(), data.data(), static_cast<gssize>(data.size()), &err);
    if (!ok) {
        g_warning("writing %s failed: %s", path.c_str(), err->message);
        g_error_free(err);
    }
    return ok;
}

json load_json(const std::string &path, json fallback) {
    std::string text;
    if (!read_file(path, text))
        return fallback;
    try {
        return json::parse(text);
    } catch (const std::exception &e) {
        g_warning("ignoring corrupt %s: %s", path.c_str(), e.what());
        return fallback;
    }
}

void save_json(const std::string &path, const json &j) {
    write_file_atomic(path, j.dump(1));
}

void run_on_main(std::function<void()> fn) {
    auto *heap = new std::function<void()>(std::move(fn));
    g_idle_add_full(G_PRIORITY_DEFAULT, [](gpointer p) -> gboolean {
        (*static_cast<std::function<void()> *>(p))();
        return G_SOURCE_REMOVE;
    }, heap, [](gpointer p) { delete static_cast<std::function<void()> *>(p); });
}

namespace {

class WorkerPool {
public:
    explicit WorkerPool(unsigned n) {
        for (unsigned i = 0; i < n; i++)
            std::thread([this] { loop(); }).detach();
    }
    void push(std::function<void()> fn) {
        {
            std::lock_guard lock(mutex_);
            queue_.push_back(std::move(fn));
        }
        cv_.notify_one();
    }

private:
    void loop() {
        for (;;) {
            std::function<void()> fn;
            {
                std::unique_lock lock(mutex_);
                cv_.wait(lock, [this] { return !queue_.empty(); });
                fn = std::move(queue_.front());
                queue_.pop_front();
            }
            try {
                fn();
            } catch (const std::exception &e) {
                g_warning("worker task failed: %s", e.what());
            }
        }
    }
    std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<std::function<void()>> queue_;
};

}  // namespace

void run_in_worker(std::function<void()> fn) {
    static auto *pool = new WorkerPool(6);  // never destroyed: threads are detached
    pool->push(std::move(fn));
}

std::string fold(const std::string &s) {
    gchar *lower = g_utf8_casefold(s.c_str(), -1);
    gchar *norm = g_utf8_normalize(lower, -1, G_NORMALIZE_NFD);
    std::string out;
    // Drop combining marks left over from NFD decomposition.
    for (const gchar *p = norm; p && *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);
        if (c >= 0x300 && c <= 0x36f)
            continue;
        char buf[8];
        out.append(buf, static_cast<size_t>(g_unichar_to_utf8(c, buf)));
    }
    g_free(norm);
    g_free(lower);
    return out;
}

std::vector<std::string> split_words(const std::string &s) {
    std::vector<std::string> words;
    std::string cur;
    for (const gchar *p = s.c_str(); *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);
        if (g_unichar_isalnum(c) || c == '\'' || c == 0x2019 || c == '-') {
            char buf[8];
            cur.append(buf, static_cast<size_t>(g_unichar_to_utf8(c, buf)));
        } else if (!cur.empty()) {
            words.push_back(cur);
            cur.clear();
        }
    }
    if (!cur.empty())
        words.push_back(cur);
    return words;
}

std::string trim(const std::string &s) {
    size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos)
        return "";
    size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

std::string random_id() {
    static std::mt19937_64 rng{std::random_device{}()};
    static std::mutex m;
    std::lock_guard lock(m);
    char buf[17];
    snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(rng()));
    return buf;
}

bool valid_language_code(const std::string &code) {
    if (code.empty() || code.size() > 32 || !g_ascii_isalpha(code[0]))
        return false;
    return std::all_of(code.begin(), code.end(),
                       [](char c) { return g_ascii_isalnum(c) || c == '_' || c == '-' || c == '@'; });
}

// ---- HTTP ----

namespace {

struct CurlInit {
    CurlInit() { curl_global_init(CURL_GLOBAL_DEFAULT); }
};

void curl_init_once() {
    static CurlInit init;
}

size_t write_string(char *ptr, size_t size, size_t n, void *ud) {
    static_cast<std::string *>(ud)->append(ptr, size * n);
    return size * n;
}

size_t write_file(char *ptr, size_t size, size_t n, void *ud) {
    return fwrite(ptr, size, n, static_cast<FILE *>(ud)) * size;
}

int progress_cb(void *ud, curl_off_t total, curl_off_t now, curl_off_t, curl_off_t) {
    auto *fn = static_cast<ProgressFn *>(ud);
    if (fn && *fn && total > 0)
        (*fn)(static_cast<double>(now) / static_cast<double>(total));
    return 0;
}

CURL *make_handle(const std::string &url) {
    curl_init_once();
    CURL *c = curl_easy_init();
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    // Wikimedia asks clients for a descriptive agent with a contact URL.
    curl_easy_setopt(c, CURLOPT_USERAGENT, "NextKeyBor/" NKB_VERSION " (https://github.com/dixonSolutions/NextKeyBor)");
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, "");
    return c;
}

void finish(CURL *c, CURLcode rc, HttpResult &r) {
    if (rc != CURLE_OK)
        r.error = curl_easy_strerror(rc);
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &r.status);
    char *ct = nullptr;
    curl_easy_getinfo(c, CURLINFO_CONTENT_TYPE, &ct);
    if (ct)
        r.content_type = ct;
    if (r.error.empty() && (r.status < 200 || r.status >= 300))
        r.error = "HTTP " + std::to_string(r.status);
    curl_easy_cleanup(c);
}

}  // namespace

HttpResult http_get(const std::string &url) {
    HttpResult r;
    CURL *c = make_handle(url);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_string);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &r.body);
    finish(c, curl_easy_perform(c), r);
    return r;
}

HttpResult http_download(const std::string &url, const std::string &dest, ProgressFn progress) {
    HttpResult r;
    std::string part = dest + ".part";
    FILE *f = g_fopen(part.c_str(), "wb");
    if (!f) {
        r.error = "cannot write " + part;
        return r;
    }
    CURL *c = make_handle(url);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_file);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, f);
    curl_easy_setopt(c, CURLOPT_LOW_SPEED_LIMIT, 100L);
    curl_easy_setopt(c, CURLOPT_LOW_SPEED_TIME, 60L);
    if (progress) {
        curl_easy_setopt(c, CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(c, CURLOPT_XFERINFOFUNCTION, progress_cb);
        curl_easy_setopt(c, CURLOPT_XFERINFODATA, &progress);
    }
    CURLcode rc = curl_easy_perform(c);
    fclose(f);
    finish(c, rc, r);
    if (r.error.empty())
        g_rename(part.c_str(), dest.c_str());
    else
        g_unlink(part.c_str());
    return r;
}

std::string url_escape(const std::string &s) {
    curl_init_once();
    char *e = curl_easy_escape(nullptr, s.c_str(), static_cast<int>(s.size()));
    std::string out = e ? e : "";
    curl_free(e);
    return out;
}

// ---- settings ----

GSettings *settings() {
    static GSettings *s = []() -> GSettings * {
        GSettingsSchemaSource *src = g_settings_schema_source_get_default();
        GSettingsSchema *schema =
            src ? g_settings_schema_source_lookup(src, "io.github.nextkeybor", TRUE) : nullptr;
        if (!schema) {
            g_warning("GSettings schema io.github.nextkeybor is not installed; using defaults");
            return nullptr;
        }
        GSettings *gs = g_settings_new_full(schema, nullptr, nullptr);
        g_settings_schema_unref(schema);
        return gs;
    }();
    return s;
}

std::string setting_string(const char *key, const std::string &fallback) {
    if (!settings())
        return fallback;
    gchar *v = g_settings_get_string(settings(), key);
    std::string out = v;
    g_free(v);
    return out;
}

bool setting_bool(const char *key, bool fallback) {
    return settings() ? g_settings_get_boolean(settings(), key) : fallback;
}

int setting_int(const char *key, int fallback) {
    return settings() ? g_settings_get_int(settings(), key) : fallback;
}

std::vector<std::string> setting_strv(const char *key, std::vector<std::string> fallback) {
    if (!settings())
        return fallback;
    gchar **v = g_settings_get_strv(settings(), key);
    std::vector<std::string> out;
    for (gchar **p = v; *p; p++)
        out.emplace_back(*p);
    g_strfreev(v);
    return out;
}

}  // namespace nkb
