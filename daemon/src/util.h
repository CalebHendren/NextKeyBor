// Small shared helpers: paths, JSON files, main-loop marshalling, HTTP, text.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include <gio/gio.h>
#include <nlohmann/json.hpp>

namespace nkb {

using json = nlohmann::json;

// ~/.local/share/nextkeybor/<sub>, created on demand.
std::string data_dir(const std::string &sub = "");
// ~/.cache/nextkeybor/<sub>, created on demand.
std::string cache_dir(const std::string &sub = "");
std::string join_path(const std::string &a, const std::string &b);
bool file_exists(const std::string &path);

bool read_file(const std::string &path, std::string &out);
// Writes through a temporary file and rename so a crash never leaves half a file.
bool write_file_atomic(const std::string &path, const std::string &data);
json load_json(const std::string &path, json fallback);
void save_json(const std::string &path, const json &j);

// Runs fn on the GLib main loop (safe to call from any thread).
void run_on_main(std::function<void()> fn);
// Runs fn on a shared worker pool.
void run_in_worker(std::function<void()> fn);

// Lower-cases and strips accents so "Café" matches "cafe".
std::string fold(const std::string &s);
std::vector<std::string> split_words(const std::string &s);
std::string trim(const std::string &s);
std::string random_id();
// A language code safe to put in a file name or URL: "en_US", "pt_BR",
// "ca_ES-valencia", "sr@latin", "auto". Letters first, then letters, digits,
// '_', '-' and '@'; no dots or slashes.
bool valid_language_code(const std::string &code);

// Blocking HTTP helpers for worker threads.
struct HttpResult {
    long status = 0;
    std::string body;
    std::string error;
    std::string content_type;
    bool ok() const { return error.empty() && status >= 200 && status < 300; }
};
using ProgressFn = std::function<void(double fraction)>;
HttpResult http_get(const std::string &url);
// Downloads to dest (via dest.part); progress is called from the worker thread.
HttpResult http_download(const std::string &url, const std::string &dest,
                         ProgressFn progress = nullptr);
std::string url_escape(const std::string &s);

// GSettings for io.github.nextkeybor, or nullptr when the schema is not installed.
GSettings *settings();
std::string setting_string(const char *key, const std::string &fallback);
bool setting_bool(const char *key, bool fallback);
int setting_int(const char *key, int fallback);
std::vector<std::string> setting_strv(const char *key, std::vector<std::string> fallback);

}  // namespace nkb
