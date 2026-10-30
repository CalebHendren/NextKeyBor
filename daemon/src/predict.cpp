#include "predict.h"

#include <algorithm>
#include <cstdio>
#include <functional>
#include <cmath>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <unordered_map>
#include <unordered_set>

#include "dbus_service.h"
#include "util.h"

namespace nkb::predict {

namespace {

struct Entry {
    std::string key;    // folded, for lookup
    std::string word;   // as it should be written
    double base;        // dictionary score
    bool stem = false;  // in the hunspell word list (a real word, not just a frequent token)
    size_t rank = 0;    // place in the frequency list (1 = most common), 0 if not in it
    bool extra = false; // from kEnglishExtras: a name worth offering as is
};

class Model {
public:
    explicit Model(std::string lang) : lang_(std::move(lang)) {
        load_user();
        build();
        maybe_fetch_frequencies();
    }

    std::vector<std::string> suggest(const std::string &context, unsigned max);
    std::string autocorrect(const std::string &context, bool fix_typos);
    void accept(const std::string &word);
    std::vector<std::string> swipe(const std::string &context, const std::map<gunichar, Point> &keys,
                                   const std::vector<Point> &path, unsigned max);
    void learn(const std::string &text);
    void forget(const std::string &word);
    void build();

private:
    std::string user_path() const { return join_path(data_dir(), "words-" + lang_ + ".json"); }
    std::string freq_path() const { return join_path(data_dir("wordfreq"), freq_code() + "_50k.txt"); }
    std::string freq_code() const;
    void load_user();
    void schedule_save();
    void maybe_fetch_frequencies();
    double score(const Entry &e) const;
    void add_candidates(const std::string &prefix_key, std::map<std::string, double> &out) const;
    void for_each_edit(const std::string &key, const std::function<void(const std::string &, double)> &fn) const;
    std::unordered_map<size_t, double> corrections(const std::string &key) const;
    void add_two_slips(const std::string &key, std::unordered_map<size_t, double> &out) const;
    void add_corrections(const std::string &key, std::map<std::string, double> &out) const;
    double likelihood(const Entry &e) const;

    std::string lang_;
    std::vector<Entry> entries_;                         // sorted by key
    std::unordered_map<std::string, size_t> exact_;       // key -> index
    std::set<gunichar> alphabet_;
    json user_ = json::object();
    std::unordered_set<std::string> blocked_;
    guint save_id_ = 0;
    bool fetching_ = false;
};

constexpr size_t kUnranked = 100000;  // the rank given to dictionary words missing from the frequency list
constexpr size_t kExtraRank = 8000;   // and the rank given to kEnglishExtras

// Words people type far more than films say them, which hunspell lacks or
// the subtitle frequency list ranks too low: without them "Reddit" swipes
// as "geddit". Spelled as they should be written.
const char *const kEnglishExtras[] = {
    "Reddit", "subreddit", "subreddits", "upvote", "upvoted", "downvote", "TikTok", "WhatsApp", "Spotify",
    "Snapchat", "LinkedIn", "Gmail", "ChatGPT", "Pinterest", "Tumblr", "Venmo", "Airbnb", "Lyft", "DoorDash",
    "Xbox", "Minecraft", "Roblox", "Etsy", "Hulu", "iCloud", "macOS", "Siri", "YouTube", "YouTuber", "apps",
    "memes", "emojis", "omg", "idk", "tbh", "thx", "pls", "plz", "jk", "smh", "lol", "lmao", "brb", "btw",
    "imo", "fyi", "ikr", "nvm", "ppl",
};

// Words in the dictionary that phone keyboards still fix, because people
// nearly always mean the other: "cant" is a word, but rarely the one meant.
const std::pair<const char *, const char *> kEnglishFixes[] = {
    {"alot", "a lot"}, {"cant", "can't"}, {"wont", "won't"},
};

std::map<std::string, std::unique_ptr<Model>> g_models;
std::string g_active;

// ---- key layout ----
//
// Where the letter keys are, in key widths with rows one unit apart, so
// corrections know which slips are likely: "hapoy" is "happy" (o is next to
// p), "hazpy" much less so. The extension sends the keyboard on screen
// (SetKeyLayout); until then, QWERTY.

double dist(Point a, Point b) {
    return std::hypot(a.x - b.x, a.y - b.y);
}

double dist2(Point a, Point b) {
    return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
}

// The keys with y divided by the distance between rows: rows are often
// taller (portrait) or shorter than keys are wide, and people miss by a share
// of a key. Returns that distance.
double normalise_rows(const std::map<gunichar, Point> &in, std::map<gunichar, Point> &out) {
    std::vector<double> ys;
    for (const auto &[c, pt] : in)
        ys.push_back(pt.y);
    std::sort(ys.begin(), ys.end());
    double row_step = 1.0;
    if (!ys.empty()) {
        std::vector<double> rows{ys.front()};
        for (double y : ys)
            if (y - rows.back() > 0.3)
                rows.push_back(y);
        if (rows.size() >= 2) {
            std::vector<double> steps;
            for (size_t i = 1; i < rows.size(); i++)
                steps.push_back(rows[i] - rows[i - 1]);
            std::sort(steps.begin(), steps.end());
            row_step = std::clamp(steps[steps.size() / 2], 0.5, 3.0);
        }
    }
    out.clear();
    for (const auto &[c, pt] : in)
        out[c] = {pt.x, pt.y / row_step};
    return row_step;
}

std::map<gunichar, Point> g_layout;

const std::map<gunichar, Point> &key_layout() {
    static const std::map<gunichar, Point> qwerty = [] {
        std::map<gunichar, Point> keys;
        const char *rows[] = {"qwertyuiop", "asdfghjkl", "zxcvbnm"};
        for (int r = 0; r < 3; r++)
            for (int i = 0; rows[r][i]; i++)
                keys[static_cast<gunichar>(rows[r][i])] = {i + 0.5 * r + (r == 2 ? 0.5 : 0.0), static_cast<double>(r)};
        return keys;
    }();
    return g_layout.empty() ? qwerty : g_layout;
}

// Distance between two letters' keys, or -1 if either is not a letter key
// (accented letters are on long-press, for one).
double key_distance(gunichar a, gunichar b) {
    const auto &keys = key_layout();
    auto ka = keys.find(g_unichar_tolower(a)), kb = keys.find(g_unichar_tolower(b));
    if (ka == keys.end() || kb == keys.end())
        return -1;
    return dist(ka->second, kb->second);
}

constexpr double kEditTransposed = 3.0;   // swapped letters ("teh") are the commonest slip
constexpr double kEditNear = 2.0;         // a letter typed on the very key meant would weigh this
constexpr double kEditFar = 0.15;         // and one typed far from it this
constexpr double kEditReach = 1.2;        // how quickly that falls off, in keys
constexpr double kEditExtraNear = 1.5;    // an extra letter from a key next to its neighbour
constexpr double kEditExtraFar = 0.6;     // an extra letter from anywhere else
constexpr double kEditSecond = 0.05;      // a second slip in the same word
constexpr glong kEditTwoMinLength = 6;    // only words this long get a second slip

// How likely typing `typed` instead of `meant` is.
double substitution_weight(gunichar typed, gunichar meant) {
    double d = key_distance(typed, meant);
    if (d < 0)
        return 1.0;
    return kEditFar + (kEditNear - kEditFar) * std::exp(-d * d / (2 * kEditReach * kEditReach));
}

std::string dic_path(const std::string &lang) {
    for (const char *dir : {"/usr/share/hunspell", "/usr/share/myspell", "/usr/local/share/hunspell"}) {
        std::string p = join_path(dir, lang + ".dic");
        if (file_exists(p))
            return p;
    }
    return "";
}

std::string Model::freq_code() const {
    std::string l = lang_;
    std::transform(l.begin(), l.end(), l.begin(), ::tolower);
    if (l == "pt_br" || l == "zh_cn" || l == "zh_tw")
        return l;
    return l.substr(0, l.find('_'));
}

void Model::load_user() {
    user_ = load_json(user_path(), json::object());
    if (!user_.is_object())
        user_ = json::object();
    for (const char *k : {"unigrams", "bigrams"})
        if (!user_.contains(k) || !user_[k].is_object())
            user_[k] = json::object();
    if (!user_.contains("blocked") || !user_["blocked"].is_array())
        user_["blocked"] = json::array();
    for (const auto &w : user_["blocked"])
        blocked_.insert(w.get<std::string>());
}

void Model::schedule_save() {
    if (save_id_)
        return;
    save_id_ = g_timeout_add_seconds(5, [](gpointer self) -> gboolean {
        auto *m = static_cast<Model *>(self);
        m->save_id_ = 0;
        save_json(m->user_path(), m->user_);
        return G_SOURCE_REMOVE;
    }, this);
}

// Lower-case letters with inner apostrophes only: no names, no junk tokens.
bool is_plain_word(const std::string &w) {
    for (const gchar *p = w.c_str(); *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);
        if (!(g_unichar_isalpha(c) && g_unichar_islower(c)) && c != '\'')
            return false;
    }
    return !w.empty() && w.front() != '\'' && w.back() != '\'';
}

void Model::build() {
    std::unordered_map<std::string, Entry> words;

    // Hunspell stems (no affix expansion); the file's first line is the count.
    std::string dic = dic_path(lang_), text;
    if (!dic.empty() && read_file(dic, text)) {
        size_t pos = text.find('\n');
        while (pos != std::string::npos && pos + 1 < text.size()) {
            size_t end = text.find('\n', pos + 1);
            std::string line = text.substr(pos + 1, end == std::string::npos ? std::string::npos : end - pos - 1);
            pos = end;
            size_t cut = line.find_first_of("/\t ");
            std::string w = line.substr(0, cut);
            if (w.empty() || !g_utf8_validate(w.c_str(), -1, nullptr))
                continue;
            if (std::any_of(w.begin(), w.end(), [](char c) { return g_ascii_isdigit(c) || c == '.'; }))
                continue;
            std::string key = fold(w);
            auto [it, inserted] = words.emplace(key, Entry{key, w, 1.0, true});
            // "he" and "He" (helium) fold together: prefer the lower-case spelling.
            if (!inserted && g_unichar_islower(g_utf8_get_char(w.c_str())))
                it->second.word = w;
        }
    }
    bool have_dic = !words.empty();

    // Frequency ranking: "word count" per line, most common first.
    if (read_file(freq_path(), text)) {
        size_t rank = 0, pos = 0;
        while (pos < text.size()) {
            size_t end = text.find('\n', pos);
            if (end == std::string::npos)
                end = text.size();
            std::string line = text.substr(pos, end - pos);
            pos = end + 1;
            std::string w = line.substr(0, line.find(' '));
            if (w.empty() || !g_utf8_validate(w.c_str(), -1, nullptr))
                continue;
            rank++;
            std::string key = fold(w);
            double s = 10.0 + 1000.0 / (1.0 + static_cast<double>(rank) / 20.0);
            auto it = words.find(key);
            if (it != words.end()) {
                it->second.base = std::max(it->second.base, s);
                if (!it->second.rank)
                    it->second.rank = rank;
            } else if (!have_dic || rank <= 3000 || (rank <= 20000 && is_plain_word(w))) {
                // The stem list has no inflections ("typing", "worked"): take
                // common words from the frequency list instead.
                words.emplace(key, Entry{key, w, s, false, rank});
            }
        }
    }

    if (freq_code() == "en")
        for (const char *w : kEnglishExtras) {
            std::string key = fold(w);
            Entry &e = words.try_emplace(key, Entry{key, w, 1.0, true}).first->second;
            e.word = w;
            e.rank = e.rank ? std::min(e.rank, kExtraRank) : kExtraRank;
            e.base = std::max(e.base, 10.0 + 1000.0 / (1.0 + static_cast<double>(e.rank) / 20.0));
            e.extra = true;
        }

    // Words only the user has typed (twice or more) join the vocabulary.
    for (auto &[w, c] : user_["unigrams"].items()) {
        std::string key = fold(w);
        if (!words.count(key) && c.get<int>() >= 2)
            words.emplace(key, Entry{key, w, 5.0});
    }

    // English "I" is always capitalised, whatever the word lists say.
    if (freq_code() == "en") {
        auto i = words.find("i");
        if (i != words.end())
            i->second.word = "I";
    }

    entries_.clear();
    entries_.reserve(words.size());
    for (auto &[k, e] : words)
        entries_.push_back(std::move(e));
    std::sort(entries_.begin(), entries_.end(), [](const Entry &a, const Entry &b) { return a.key < b.key; });
    exact_.clear();
    alphabet_.clear();
    for (size_t i = 0; i < entries_.size(); i++) {
        exact_[entries_[i].key] = i;
        if (entries_[i].base > 10)
            for (const gchar *p = entries_[i].key.c_str(); *p; p = g_utf8_next_char(p))
                alphabet_.insert(g_utf8_get_char(p));
    }
    if (alphabet_.empty())
        for (gunichar c = 'a'; c <= 'z'; c++)
            alphabet_.insert(c);
    g_message("predict: %s has %zu words", lang_.c_str(), entries_.size());
}

void Model::maybe_fetch_frequencies() {
    if (file_exists(freq_path()) || fetching_)
        return;
    fetching_ = true;
    std::string code = freq_code(), dest = freq_path(), lang = lang_;
    run_in_worker([code, dest, lang] {
        auto r = http_download("https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/" +
                                   code + "/" + code + "_50k.txt",
                               dest);
        if (!r.ok()) {
            g_message("no word frequency list for %s: %s", code.c_str(), r.error.c_str());
            return;
        }
        run_on_main([lang] {
            auto it = g_models.find(lang);
            if (it != g_models.end())
                it->second->build();
        });
    });
}

// Roughly how likely the word is: frequencies follow Zipf's law, so about
// 1/rank, and a word the user has typed counts as a common one.
double Model::likelihood(const Entry &e) const {
    double p = 1.0 / static_cast<double>(e.rank ? e.rank : kUnranked);
    auto it = user_["unigrams"].find(e.word);
    if (it == user_["unigrams"].end())
        it = user_["unigrams"].find(e.key);
    if (it != user_["unigrams"].end())
        p += it->get<double>() / 200.0;
    return p;
}

double Model::score(const Entry &e) const {
    double s = e.base;
    auto it = user_["unigrams"].find(e.word);
    if (it == user_["unigrams"].end())
        it = user_["unigrams"].find(e.key);
    if (it != user_["unigrams"].end())
        s += 400.0 * it->get<double>();
    return s;
}

void Model::add_candidates(const std::string &prefix_key, std::map<std::string, double> &out) const {
    auto lo = std::lower_bound(entries_.begin(), entries_.end(), prefix_key,
                               [](const Entry &e, const std::string &k) { return e.key < k; });
    for (auto it = lo; it != entries_.end() && it->key.compare(0, prefix_key.size(), prefix_key) == 0; ++it) {
        if (blocked_.count(it->key))
            continue;
        double s = score(*it);
        if (it->key == prefix_key)
            s *= 1.5;  // the word as typed is a complete word
        auto [pos, inserted] = out.emplace(it->word, s);
        if (!inserted)
            pos->second = std::max(pos->second, s);
    }
}

// Calls fn(edit, weight) for every string at edit distance 1 from key
// (delete, transpose, replace, insert), over the language's alphabet; weight
// says how likely that slip is on the keyboard in use. An edit may come more
// than once.
void Model::for_each_edit(const std::string &key, const std::function<void(const std::string &, double)> &fn) const {
    std::vector<std::string> chars;
    std::vector<gunichar> cps;
    for (const gchar *p = key.c_str(); *p; p = g_utf8_next_char(p)) {
        chars.emplace_back(p, static_cast<size_t>(g_utf8_next_char(p) - p));
        cps.push_back(g_utf8_get_char(p));
    }
    std::vector<std::pair<gunichar, std::string>> alpha;
    for (gunichar c : alphabet_) {
        char buf[8];
        alpha.emplace_back(c, std::string(buf, static_cast<size_t>(g_unichar_to_utf8(c, buf))));
    }
    const size_t n = chars.size();
    // The key with chars [from, to) replaced by mid.
    auto splice = [&](size_t from, size_t to, const std::string &mid) {
        std::string s;
        for (size_t i = 0; i < from; i++)
            s += chars[i];
        s += mid;
        for (size_t i = to; i < n; i++)
            s += chars[i];
        return s;
    };
    for (size_t i = 0; i < n; i++) {
        // An extra letter: likelier from a key next to the letter before or
        // after it (or the same key twice).
        if (n >= 4) {
            double w = kEditExtraFar;
            for (size_t j : {i - 1, i + 1}) {
                if (j >= n)
                    continue;
                double d = cps[j] == cps[i] ? 0.0 : key_distance(cps[i], cps[j]);
                if (d >= 0 && d <= kEditReach)
                    w = kEditExtraNear;
            }
            fn(splice(i, i + 1, ""), w);
        }
        if (i + 1 < n && cps[i] != cps[i + 1])
            fn(splice(i, i + 2, chars[i + 1] + chars[i]), kEditTransposed);
        for (const auto &[c, a] : alpha)
            if (c != cps[i])
                fn(splice(i, i + 1, a), substitution_weight(cps[i], c));
    }
    // A missing letter.
    for (size_t i = 0; i <= n; i++)
        for (const auto &[c, a] : alpha)
            fn(splice(i, i, a), 1.0);
}

// Known words one slip from key, or for long words two slips when none is
// one away: entry index -> how likely the slip (see for_each_edit).
std::unordered_map<size_t, double> Model::corrections(const std::string &key) const {
    std::unordered_map<size_t, double> out;
    std::unordered_map<std::string, double> edits;
    for_each_edit(key, [&](const std::string &e, double w) {
        double &best = edits[e];
        best = std::max(best, w);
    });
    edits.erase(key);
    auto note = [&](const std::string &e, double w) {
        auto it = exact_.find(e);
        if (it == exact_.end() || blocked_.count(e))
            return;
        double &best = out[it->second];
        best = std::max(best, w);
    };
    for (const auto &[e, w] : edits)
        note(e, w);
    if (out.empty() && g_utf8_strlen(key.c_str(), -1) >= kEditTwoMinLength)
        add_two_slips(key, out);
    return out;
}

// Known words exactly two slips from key (optimal string alignment
// distance), each with weight kEditSecond. Generating every edit of every
// edit is too slow to do per key press, so this walks the sorted word list
// instead, sharing the distance rows between words with a common prefix and
// skipping every word under a prefix that is already too far off.
void Model::add_two_slips(const std::string &key, std::unordered_map<size_t, double> &out) const {
    std::vector<gunichar> a;
    for (const gchar *p = key.c_str(); *p; p = g_utf8_next_char(p))
        a.push_back(g_utf8_get_char(p));
    const size_t n = a.size();
    std::vector<std::vector<int>> rows(1, std::vector<int>(n + 1));
    for (size_t j = 0; j <= n; j++)
        rows[0][j] = static_cast<int>(j);
    std::vector<gunichar> done, w;  // done: the prefix rows[1..] are for
    std::string skip;              // no word starting with this is close enough
    for (size_t i = 0; i < entries_.size(); i++) {
        const std::string &k = entries_[i].key;
        if (!skip.empty() && k.compare(0, skip.size(), skip) == 0)
            continue;
        skip.clear();
        w.clear();
        for (const gchar *p = k.c_str(); *p; p = g_utf8_next_char(p))
            w.push_back(g_utf8_get_char(p));
        if (w.size() + 2 < n || w.size() > n + 2)
            continue;
        size_t common = 0;
        while (common < done.size() && common < w.size() && done[common] == w[common])
            common++;
        done.resize(common);
        bool far = false;
        for (size_t d = common + 1; d <= w.size(); d++) {
            if (rows.size() <= d)
                rows.emplace_back(n + 1);
            auto &row = rows[d];
            const auto &up = rows[d - 1];
            row[0] = static_cast<int>(d);
            int best = row[0];
            for (size_t j = 1; j <= n; j++) {
                int v = std::min({up[j] + 1, row[j - 1] + 1, up[j - 1] + (w[d - 1] == a[j - 1] ? 0 : 1)});
                if (d > 1 && j > 1 && w[d - 1] == a[j - 2] && w[d - 2] == a[j - 1])
                    v = std::min(v, rows[d - 2][j - 2] + 1);
                row[j] = v;
                best = std::min(best, v);
            }
            done.push_back(w[d - 1]);
            if (best > 2) {
                skip = k.substr(0, static_cast<size_t>(g_utf8_offset_to_pointer(k.c_str(), static_cast<glong>(d)) - k.c_str()));
                far = true;
                break;
            }
        }
        if (!far && rows[w.size()][n] == 2 && !blocked_.count(k))
            out.emplace(i, kEditSecond);
    }
}

void Model::add_corrections(const std::string &key, std::map<std::string, double> &out) const {
    for (const auto &[i, w] : corrections(key)) {
        const Entry &en = entries_[i];
        double s = score(en) * 0.3 * w;
        auto [pos, inserted] = out.emplace(en.word, s);
        if (!inserted)
            pos->second = std::max(pos->second, s);
    }
}

std::string match_case(const std::string &typed, const std::string &word) {
    if (typed.empty())
        return word;
    gunichar first = g_utf8_get_char(typed.c_str());
    if (!g_unichar_isupper(first))
        return word;
    bool all_upper = g_utf8_strlen(typed.c_str(), -1) > 1;
    for (const gchar *p = typed.c_str(); *p && all_upper; p = g_utf8_next_char(p))
        if (g_unichar_islower(g_utf8_get_char(p)))
            all_upper = false;
    if (all_upper) {
        gchar *u = g_utf8_strup(word.c_str(), -1);
        std::string out = u;
        g_free(u);
        return out;
    }
    gunichar c = g_unichar_toupper(g_utf8_get_char(word.c_str()));
    char buf[8];
    std::string out(buf, static_cast<size_t>(g_unichar_to_utf8(c, buf)));
    out += g_utf8_next_char(word.c_str());
    return out;
}

std::vector<std::string> Model::suggest(const std::string &context, unsigned max) {
    std::map<std::string, double> cand;
    auto words = split_words(context);
    bool next_word = context.empty() || !g_unichar_isalnum(g_utf8_get_char(
                                            g_utf8_prev_char(context.c_str() + context.size())));
    // An apostrophe/hyphen inside a word still counts as part of it.
    if (!context.empty() && (context.back() == '\'' || context.back() == '-'))
        next_word = false;

    std::string typed = next_word || words.empty() ? "" : words.back();
    std::string prev;
    if (next_word && !words.empty())
        prev = words.back();
    else if (!next_word && words.size() >= 2)
        prev = words[words.size() - 2];
    std::string prev_key = fold(prev);

    if (!typed.empty()) {
        std::string key = fold(typed);
        add_candidates(key, cand);
        // Only look for typos when the prefix does not lead anywhere useful.
        glong len = g_utf8_strlen(key.c_str(), -1);
        if (len >= 3 && len <= 20 && cand.size() < max)
            add_corrections(key, cand);
    }

    // Bigram boost / next-word prediction.
    auto bi = user_["bigrams"].find(prev_key);
    if (!prev_key.empty() && bi != user_["bigrams"].end()) {
        std::string tkey = fold(typed);
        for (auto &[w, c] : bi->items()) {
            if (!tkey.empty() && fold(w).compare(0, tkey.size(), tkey) != 0)
                continue;
            if (blocked_.count(fold(w)))
                continue;
            cand[w] += 2000.0 * c.get<double>();
        }
    }
    if (next_word && cand.size() < max) {
        // Fall back to the most common words.
        std::vector<const Entry *> top;
        for (const auto &e : entries_)
            if (e.base > 500)
                top.push_back(&e);
        std::sort(top.begin(), top.end(), [this](const Entry *a, const Entry *b) { return score(*a) > score(*b); });
        for (size_t i = 0; i < top.size() && cand.size() < max * 2; i++)
            cand.emplace(top[i]->word, score(*top[i]) * 0.1);
    }

    std::vector<std::pair<std::string, double>> ranked(cand.begin(), cand.end());
    std::sort(ranked.begin(), ranked.end(), [](auto &a, auto &b) { return a.second > b.second; });
    std::vector<std::string> out;
    std::set<std::string> seen;
    for (auto &[w, s] : ranked) {
        std::string shown = match_case(typed, w);
        if (!seen.insert(shown).second)
            continue;
        out.push_back(shown);
        if (out.size() >= max)
            break;
    }
    // Put the literally typed word first if it is a known word, like phone keyboards do.
    if (!typed.empty()) {
        auto it = std::find(out.begin(), out.end(), typed);
        if (it != out.end() && it != out.begin())
            std::rotate(out.begin(), it, it + 1);
    }
    return out;
}

// ---- swipe typing ----
//
// Each candidate word is matched to the swipe as a hidden Markov model. The
// finger path, resampled evenly, is split in order into a lead-in, one point
// per letter (where the finger "hit" it), the stretches between letters,
// which should follow the straight line from one key to the next, and a
// run-on after the last letter. Viterbi finds the best split, and its cost
// says how unlikely the path is for that word. Unlike comparing the path
// point by point with an ideal one, this copes with what real fingers do:
// rounding corners, aiming off-centre, starting early and overshooting.

constexpr double kSwipeStep = 0.15;         // resampling step, in keys
constexpr size_t kSwipeMaxPoints = 48;
constexpr size_t kSwipeKeep = 12;           // best words kept for the final list
constexpr double kSwipeLetterSigma = 0.35;   // how far a letter may be from where the finger passed
constexpr double kSwipeLineSigma = 0.4;     // how far the path may stray from the line between letters
constexpr double kSwipeEndReach = 1.6;      // first/last letter within this of the path's ends
constexpr double kSwipeLetterReach = 1.5;   // every letter within this of the path
constexpr double kSwipeEndArc = 0.8;        // "the path's ends": this much path at either end
constexpr double kSwipeFreqWeight = 0.8;    // log word frequency against the path cost
constexpr double kSwipeNamePenalty = 2.0;   // capitalised words and acronyms the user never typed
constexpr double kSwipeEndScale = 3.0;      // path before the first letter or after the last costs more
constexpr double kSwipeTurnBonus = 2.0;     // letters tend to sit where the path turns or slows

// Squared distance from p to the segment ab.
double seg_dist2(Point p, Point a, Point b) {
    double dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    double t = len2 > 0 ? std::clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0.0, 1.0) : 0.0;
    return dist2(p, {a.x + t * dx, a.y + t * dy});
}

double path_length(const std::vector<Point> &pts) {
    double total = 0;
    for (size_t i = 1; i < pts.size(); i++)
        total += dist(pts[i], pts[i - 1]);
    return total;
}

// Points every `step` along the path, with times interpolated.
std::vector<Point> resample(const std::vector<Point> &in, double step) {
    std::vector<Point> out{in.front()};
    double acc = 0;  // path walked since the last point out
    for (size_t i = 1; i < in.size(); i++) {
        Point a = in[i - 1], b = in[i];
        double d = dist(a, b), done = 0;
        while (d - done + acc >= step) {
            done += step - acc;
            acc = 0;
            double f = done / d;
            out.push_back({a.x + f * (b.x - a.x), a.y + f * (b.y - a.y), a.t + f * (b.t - a.t)});
        }
        acc += d - done;
    }
    if (acc > step * 0.3 || out.size() < 2)
        out.push_back(in.back());
    return out;
}

// For each path point, how much it looks like a letter: the path turns
// there or the finger slows down. 0 to 1.
std::vector<double> letter_likeness(const std::vector<Point> &p) {
    const size_t n = p.size(), w = 3;
    std::vector<double> out(n, 0.0);
    std::vector<double> dt(n, 0.0);
    bool timed = p.back().t > p.front().t;
    for (size_t j = 0; j < n && timed; j++)
        dt[j] = (p[std::min(j + 1, n - 1)].t - p[j > 0 ? j - 1 : 0].t);
    double median = 0;
    if (timed) {
        std::vector<double> sorted = dt;
        std::nth_element(sorted.begin(), sorted.begin() + static_cast<long>(n / 2), sorted.end());
        median = sorted[n / 2];
    }
    for (size_t j = w; j + w < n; j++) {
        double ax = p[j].x - p[j - w].x, ay = p[j].y - p[j - w].y;
        double bx = p[j + w].x - p[j].x, by = p[j + w].y - p[j].y;
        double na = std::hypot(ax, ay), nb = std::hypot(bx, by);
        if (na > 1e-9 && nb > 1e-9) {
            double angle = std::acos(std::clamp((ax * bx + ay * by) / (na * nb), -1.0, 1.0));
            out[j] = std::min(1.0, angle / (M_PI / 2));
        }
    }
    if (median > 0)
        for (size_t j = 0; j < n; j++)
            out[j] = std::max(out[j], std::clamp(dt[j] / median - 1.0, 0.0, 2.0) / 2.0);
    return out;
}

// Matches key sequences against one swipe path with Viterbi. States: 0 the
// lead-in, 2i+1 letter i (exactly one point), 2i+2 the line from letter i to
// i+1 (any number of points), 2n the run-on. Per-point costs for each key and
// each line between two keys are worked out once per swipe and shared by
// all the words tried.
class Aligner {
public:
    // step: the path's resampling step, so that costs along lines add up per
    // key of path whatever the number of points.
    Aligner(const std::vector<Point> &path, double step, const std::vector<double> &likeness,
            const std::vector<Point> &keys)
        : path_(path), keys_(keys), m_(path.size()) {
        const double letter_scale = 1.0 / (2 * kSwipeLetterSigma * kSwipeLetterSigma);
        line_scale_ = step / (2 * kSwipeLineSigma * kSwipeLineSigma);
        letter_.resize(keys.size() * m_);
        near_.resize(keys.size() * m_);
        for (size_t k = 0; k < keys.size(); k++)
            for (size_t j = 0; j < m_; j++) {
                double d2 = dist2(path[j], keys[k]);
                letter_[k * m_ + j] = letter_scale * d2 - kSwipeTurnBonus * likeness[j];
                near_[k * m_ + j] = kSwipeEndScale * line_scale_ * d2;
            }
    }

    // Cost of the path for keys seq (indexes, at least two); gives up and
    // returns infinity once it is sure to pass budget.
    double cost(const std::vector<int> &seq, double budget) {
        constexpr double inf = std::numeric_limits<double>::infinity();
        const size_t n = seq.size(), states = 2 * n + 1;
        emit_.resize(states);
        for (size_t s = 0; s < states; s++) {
            if (s == 0)
                emit_[s] = &near_[static_cast<size_t>(seq[0]) * m_];
            else if (s == states - 1)
                emit_[s] = &near_[static_cast<size_t>(seq[n - 1]) * m_];
            else if (s % 2 == 1)
                emit_[s] = &letter_[static_cast<size_t>(seq[s / 2]) * m_];
            else
                emit_[s] = line(seq[s / 2 - 1], seq[s / 2]);
        }
        cur_.assign(states, inf);
        cur_[0] = emit_[0][0];
        cur_[1] = emit_[1][0];
        for (size_t j = 1; j < m_; j++) {
            next_.assign(states, inf);
            double bound = inf;
            for (size_t s = 0; s < states; s++) {
                double best = s % 2 == 0 ? cur_[s] : inf;  // lead-in, lines and run-on take many points
                if (s > 0)
                    best = std::min(best, cur_[s - 1]);
                if (s % 2 == 1 && s >= 3)
                    best = std::min(best, cur_[s - 2]);  // no points on the line between two letters
                if (best == inf)
                    continue;
                next_[s] = best + emit_[s][j];
                // Each letter still ahead can take off at most the turn bonus.
                bound = std::min(bound, next_[s] - static_cast<double>(n - (s + 1) / 2) * kSwipeTurnBonus);
            }
            std::swap(cur_, next_);
            if (bound > budget)
                return inf;
        }
        return std::min(cur_[states - 1], cur_[states - 2]);
    }

private:
    const double *line(int a, int b) {
        auto [it, inserted] = lines_.try_emplace(a * 1024 + b);
        if (inserted) {
            it->second.resize(m_);
            for (size_t j = 0; j < m_; j++)
                it->second[j] = line_scale_ * seg_dist2(path_[j], keys_[static_cast<size_t>(a)],
                                                         keys_[static_cast<size_t>(b)]);
        }
        return it->second.data();
    }

    const std::vector<Point> &path_;
    const std::vector<Point> &keys_;
    size_t m_;
    double line_scale_;
    std::vector<double> letter_, near_;
    std::unordered_map<int, std::vector<double>> lines_;
    std::vector<const double *> emit_;
    std::vector<double> cur_, next_;
};

// "skill's" rather than a contraction such as "that's": the plain spelling
// ("skills") is then a real word that the stem list just lacks.
bool is_possessive(const std::string &word) {
    static const std::set<std::string> contracted = {
        "it", "that", "what", "he", "she", "there", "here", "who", "where", "how", "let", "when",
        "why", "everyone", "everybody", "nobody", "someone", "somebody", "something", "nothing"};
    if (word.size() < 3 || word.compare(word.size() - 2, 2, "'s") != 0)
        return false;
    return !contracted.count(fold(word.substr(0, word.size() - 2)));
}

std::vector<std::string> Model::swipe(const std::string &context, const std::map<gunichar, Point> &key_map,
                                      const std::vector<Point> &raw, unsigned max) {
    if (raw.size() < 2 || key_map.empty())
        return {};

    // Measure distances in keys both ways.
    std::map<gunichar, Point> keys;
    const double row_step = normalise_rows(key_map, keys);
    std::vector<Point> scaled;
    for (const auto &pt : raw)
        if (scaled.empty() || dist(scaled.back(), {pt.x, pt.y / row_step}) > 1e-6 || &pt == &raw.back())
            scaled.push_back({pt.x, pt.y / row_step, pt.t});

    const double user_len = path_length(scaled);
    const double step = std::max(kSwipeStep, user_len / static_cast<double>(kSwipeMaxPoints));
    const auto path = resample(scaled, step);
    const auto likeness = letter_likeness(path);

    // Letters near either end of the path; only words that start and end on
    // one of them are worth matching.
    auto near_end = [&](bool at_start) {
        std::set<gunichar> out;
        double walked = 0;
        for (size_t i = 0; i < path.size() && walked <= kSwipeEndArc; i++) {
            const Point &q = path[at_start ? i : path.size() - 1 - i];
            for (const auto &[c, k] : keys)
                if (dist(q, k) <= kSwipeEndReach)
                    out.insert(c);
            walked += step;
        }
        return out;
    };
    const auto first_letters = near_end(true), last_letters = near_end(false);

    auto words = split_words(context);
    std::string prev_key = words.empty() ? "" : fold(words.back());
    auto bi = user_["bigrams"].find(prev_key);
    const json *bigrams = !prev_key.empty() && bi != user_["bigrams"].end() ? &*bi : nullptr;
    const json &typed = user_["unigrams"];

    // How close the finger came to each key: a word with a letter the path
    // never got near is not worth aligning.
    std::map<gunichar, int> index;
    std::vector<Point> key_pts;
    std::vector<double> nearest;
    for (const auto &[c, k] : keys) {
        index[c] = static_cast<int>(key_pts.size());
        key_pts.push_back(k);
        double best = std::numeric_limits<double>::infinity();
        for (const Point &q : path)
            best = std::min(best, dist(q, k));
        nearest.push_back(best);
    }

    // Gather the candidates and their frequency score first, then align the
    // most likely ones first so the rest can be cut short.
    struct Candidate {
        double prior;
        const Entry *entry;
        size_t begin, end;  // into stops: the word's keys in order
    };
    std::vector<Candidate> candidates;
    std::vector<int> stops;
    for (gunichar first : first_letters) {
        char buf[8];
        std::string prefix(buf, static_cast<size_t>(g_unichar_to_utf8(first, buf)));
        auto lo = std::lower_bound(entries_.begin(), entries_.end(), prefix,
                                   [](const Entry &e, const std::string &k) { return e.key < k; });
        for (auto it = lo; it != entries_.end() && it->key.compare(0, prefix.size(), prefix) == 0; ++it) {
            const Entry &e = *it;
            size_t begin = stops.size();
            bool ok = true;
            gunichar last = 0;
            for (const gchar *q = e.key.c_str(); *q && ok; q = g_utf8_next_char(q)) {
                gunichar c = g_utf8_get_char(q);
                auto k = index.find(c);
                if (k == index.end()) {
                    // A letter this layout lacks, or "mr." and the like; apostrophes
                    // and hyphens are not on the letter keys.
                    ok = c == '\'' || c == '-';
                    continue;
                }
                ok = nearest[static_cast<size_t>(k->second)] <= kSwipeLetterReach;
                last = c;
                // Double letters are one stop on the path.
                if (stops.size() == begin || stops.back() != k->second)
                    stops.push_back(k->second);
            }
            size_t n = stops.size() - begin;
            if (!ok || n < 2 || !last_letters.count(last) || blocked_.count(e.key)) {
                stops.resize(begin);
                continue;
            }
            double ideal_len = 0;
            for (size_t i = begin + 1; i < stops.size(); i++)
                ideal_len += dist(key_pts[static_cast<size_t>(stops[i])], key_pts[static_cast<size_t>(stops[i - 1])]);
            if (ideal_len > 1.6 * user_len + 1.5 || user_len > 1.6 * ideal_len + 2.0) {
                stops.resize(begin);
                continue;
            }

            bool capital = g_unichar_isupper(g_utf8_get_char(e.word.c_str()));
            bool acronym = e.word.size() > 1 && e.word != "I" &&
                           std::none_of(e.word.begin(), e.word.end(), [](char c) { return g_ascii_islower(c); });
            // More likely still right after the previous word.
            double p = likelihood(e);
            if (bigrams) {
                auto b = bigrams->find(e.word);
                if (b != bigrams->end())
                    p += b->get<double>() / 20.0;
            }
            double prior = kSwipeFreqWeight * std::log(p);
            if ((capital || acronym) && !e.extra && !typed.contains(e.word))
                prior -= kSwipeNamePenalty;  // names ("Abbas") and acronyms ("US", "FSF")
            candidates.push_back({prior, &e, begin, stops.size()});
        }
    }
    std::sort(candidates.begin(), candidates.end(), [](auto &a, auto &b) { return a.prior > b.prior; });

    // The best kSwipeKeep so far, as a min-heap on score.
    std::vector<std::pair<double, const Entry *>> scored;
    auto worse = [](auto &a, auto &b) { return a.first > b.first; };
    Aligner aligner(path, step, likeness, key_pts);
    std::vector<int> seq;
    for (const auto &c : candidates) {
        double floor = scored.size() >= kSwipeKeep ? scored.front().first : -std::numeric_limits<double>::infinity();
        if (c.prior <= floor)
            break;  // sorted by prior, and the path cost only lowers it
        seq.assign(stops.begin() + static_cast<long>(c.begin), stops.begin() + static_cast<long>(c.end));
        double total = c.prior - aligner.cost(seq, c.prior - floor);
        if (total <= floor)
            continue;
        scored.push_back({total, c.entry});
        std::push_heap(scored.begin(), scored.end(), worse);
        if (scored.size() > kSwipeKeep) {
            std::pop_heap(scored.begin(), scored.end(), worse);
            scored.pop_back();
        }
    }

    std::sort(scored.begin(), scored.end(), [](auto &a, auto &b) { return a.first > b.first; });
    // "dont" and "don't" trace the same path: list it once, with the apostrophe.
    auto letters = [](const std::string &w) {
        std::string k = fold(w);
        k.erase(std::remove_if(k.begin(), k.end(), [](char c) { return c == '\'' || c == '-'; }), k.end());
        return k;
    };
    // Only when the plain spelling is not a dictionary word ("well" stays).
    std::vector<const Entry *> picked;
    std::map<std::string, size_t> seen;  // letters -> index in picked
    for (auto &[s, e] : scored) {
        std::string key = letters(e->word);
        auto it = seen.find(key);
        if (it != seen.end()) {
            const Entry *&have = picked[it->second];
            bool apostrophe = e->word.find('\'') != std::string::npos &&
                              have->word.find('\'') == std::string::npos;
            if (apostrophe && !have->stem && !is_possessive(e->word))
                have = e;
            // Both real words ("cant" and "can't"): offer both.
            if (!(apostrophe && have->stem && have != e) || picked.size() >= max)
                continue;
            picked.push_back(e);
            continue;
        }
        // Once full, keep scanning only so an apostrophe spelling can still win.
        if (picked.size() < max) {
            seen.emplace(key, picked.size());
            picked.push_back(e);
        }
    }
    std::vector<std::string> out;
    for (const Entry *e : picked)
        out.push_back(e->word);
    return out;
}

// ---- autocorrect ----

constexpr double kAutocorrectMinLikelihood = 1.0 / 30000;  // corrections must be fairly common words
constexpr double kAutocorrectMargin = 2.0;     // and this many times likelier than the next best
constexpr double kAutocorrectShortMargin = 4.0;  // or this many for words of three letters or fewer
constexpr double kAutocorrectMisspelt = 20.0;  // how much likelier a fix must be than a listed misspelling

// The user's text shortcuts (setting text-shortcuts): "omw" -> "On my way!".
std::string shortcut_for(const std::string &word) {
    GSettings *gs = settings();
    if (!gs)
        return "";
    GVariant *v = g_settings_get_value(gs, "text-shortcuts");
    std::string key = fold(word), out;
    GVariantIter it;
    const gchar *k, *phrase;
    g_variant_iter_init(&it, v);
    while (g_variant_iter_next(&it, "{&s&s}", &k, &phrase))
        if (fold(k) == key) {
            out = phrase;
            break;
        }
    g_variant_unref(v);
    return out;
}

// What the word being typed at the end of context should become when the
// user finishes it with a space or punctuation: a shortcut's phrase, a
// contraction missing its apostrophe ("dont"), or a clear typo's fix. Empty
// when it should stay as typed.
std::string Model::autocorrect(const std::string &context, bool fix_typos) {
    if (context.empty() || !g_unichar_isalnum(g_utf8_get_char(g_utf8_prev_char(context.c_str() + context.size()))))
        return "";
    auto words = split_words(context);
    if (words.empty())
        return "";
    const std::string typed = words.back();
    // The whole token since the last space: leave URLs, addresses, handles
    // and file names alone.
    size_t space = context.find_last_of(" \t\n");
    std::string token = space == std::string::npos ? context : context.substr(space + 1);
    if (token == typed) {
        std::string phrase = shortcut_for(typed);
        if (!phrase.empty())
            return phrase;
    }
    if (!fix_typos || token.find_first_of("@/:.#_\\") != std::string::npos)
        return "";
    glong len = g_utf8_strlen(typed.c_str(), -1);
    if (len < 2 || len > 20)
        return "";
    for (const gchar *q = typed.c_str(); *q; q = g_utf8_next_char(q))
        if (g_unichar_isdigit(g_utf8_get_char(q)))
            return "";
    // A capital in mid-sentence is probably a name.
    if (g_unichar_isupper(g_utf8_get_char(typed.c_str()))) {
        std::string before = trim(context.substr(0, context.size() - typed.size()));
        if (!before.empty() && before.find_last_of(".!?") != before.size() - 1)
            return "";
    }

    const std::string key = fold(typed);
    if (freq_code() == "en" && !user_["unigrams"].contains(typed))
        for (const auto &[from, to] : kEnglishFixes)
            if (key == from)
                return match_case(typed, to);
    auto known = exact_.find(key);
    // "dont" -> "don't", "im" -> "I'm": the frequency list has contractions
    // without their apostrophes, but the dictionary has them right.
    if (known == exact_.end() || !entries_[known->second].stem) {
        for (const gchar *q = g_utf8_next_char(key.c_str()); *q; q = g_utf8_next_char(q)) {
            size_t at = static_cast<size_t>(q - key.c_str());
            auto it = exact_.find(key.substr(0, at) + "'" + key.substr(at));
            if (it != exact_.end() && entries_[it->second].stem && !blocked_.count(it->first) &&
                !is_possessive(entries_[it->second].word))
                return match_case(typed, entries_[it->second].word);
        }
    }
    // A dictionary word, or one the user types, stays. Words only in the
    // frequency list may be common misspellings ("untill"): those are fixed
    // when a dictionary word one edit away is far more common.
    double typed_p = 0;
    if (known != exact_.end()) {
        const Entry &e = entries_[known->second];
        if (e.stem || user_["unigrams"].contains(e.word))
            return "";
        typed_p = likelihood(e) * kAutocorrectMisspelt;
    }

    std::string prev = words.size() >= 2 ? fold(words[words.size() - 2]) : "";
    auto bi = user_["bigrams"].find(prev);
    const json *bigrams = !prev.empty() && bi != user_["bigrams"].end() ? &*bi : nullptr;
    std::string best;
    double first = 0, second = 0;
    for (const auto &[i, w] : corrections(key)) {
        const Entry &e = entries_[i];
        if (typed_p > 0 && !e.stem)
            continue;
        double p = likelihood(e) * w;
        if (bigrams) {
            auto b = bigrams->find(e.word);
            if (b != bigrams->end())
                p += w * b->get<double>() / 20.0;
        }
        if (p > first) {
            second = first;
            first = p;
            best = e.word;
        } else if (p > second) {
            second = p;
        }
    }
    // Short words have few neighbours, so a clear winner means less.
    double margin = len <= 3 ? kAutocorrectShortMargin : kAutocorrectMargin;
    if (best.empty() || first < kAutocorrectMinLikelihood || first < margin * second || first < typed_p)
        return "";
    return match_case(typed, best);
}

// The user undid a correction of word: keep it as typed from now on.
void Model::accept(const std::string &word) {
    std::string key = fold(word);
    blocked_.erase(key);
    auto &uni = user_["unigrams"];
    uni[word] = std::max(uni.value(word, 0), 2);
    user_["blocked"] = json(std::vector<std::string>(blocked_.begin(), blocked_.end()));
    schedule_save();
    if (!exact_.count(key))
        build();
}

void Model::learn(const std::string &text) {
    if (!setting_bool("learn-words", true))
        return;
    // Only learn finished words: drop a trailing partial word.
    auto words = split_words(text);
    if (!text.empty() && !words.empty() &&
        g_unichar_isalnum(g_utf8_get_char(g_utf8_prev_char(text.c_str() + text.size()))))
        words.pop_back();
    if (words.empty())
        return;

    auto &uni = user_["unigrams"];
    auto &bis = user_["bigrams"];
    bool vocabulary_changed = false;
    std::string prev_key;
    for (const auto &w : words) {
        if (g_utf8_strlen(w.c_str(), -1) > 40 || g_unichar_isdigit(g_utf8_get_char(w.c_str()))) {
            prev_key.clear();
            continue;
        }
        std::string key = fold(w);
        blocked_.erase(key);
        // Store the dictionary spelling for known words so "The" and "the" share a count.
        auto known = exact_.find(key);
        std::string store = known != exact_.end() ? entries_[known->second].word : w;
        int count = uni.value(store, 0) + 1;
        uni[store] = count;
        if (known == exact_.end() && count == 2)
            vocabulary_changed = true;
        if (!prev_key.empty()) {
            auto &next = bis[prev_key];
            if (!next.is_object())
                next = json::object();
            next[store] = next.value(store, 0) + 1;
        }
        prev_key = key;
    }
    // Keep the personal dictionary bounded.
    if (uni.size() > 20000) {
        for (auto it = uni.begin(); it != uni.end();)
            it = it.value().get<int>() <= 1 ? uni.erase(it) : std::next(it);
    }
    user_["blocked"] = json(std::vector<std::string>(blocked_.begin(), blocked_.end()));
    schedule_save();
    if (vocabulary_changed)
        build();
}

void Model::forget(const std::string &word) {
    std::string key = fold(word);
    blocked_.insert(key);
    auto &uni = user_["unigrams"];
    for (auto it = uni.begin(); it != uni.end();)
        it = fold(it.key()) == key ? uni.erase(it) : std::next(it);
    auto &bis = user_["bigrams"];
    bis.erase(key);
    for (auto &[k, next] : bis.items())
        for (auto it = next.begin(); it != next.end();)
            it = fold(it.key()) == key ? next.erase(it) : std::next(it);
    user_["blocked"] = json(std::vector<std::string>(blocked_.begin(), blocked_.end()));
    schedule_save();
}

Model &model_for(std::string lang) {
    if (lang.empty())
        lang = active_language();
    auto it = g_models.find(lang);
    if (it == g_models.end())
        it = g_models.emplace(lang, std::make_unique<Model>(lang)).first;
    return *it->second;
}

}  // namespace

std::string active_language() {
    if (g_active.empty())
        g_active = setting_string("active-language", "en_US");
    return g_active;
}

void set_active_language(const std::string &code) {
    g_active = code;
    if (settings())
        g_settings_set_string(settings(), "active-language", code.c_str());
}

std::vector<std::string> suggest(const std::string &context, const std::string &lang, unsigned max) {
    return model_for(lang).suggest(context, std::clamp(max, 1u, 20u));
}

void learn(const std::string &text, const std::string &lang) {
    model_for(lang).learn(text);
}

std::vector<std::string> swipe(const std::string &context, const std::string &lang,
                               const std::map<gunichar, Point> &keys, const std::vector<Point> &path,
                               unsigned max) {
    return model_for(lang).swipe(context, keys, path, std::clamp(max, 1u, 20u));
}

void reload(const std::string &lang) {
    g_models.erase(lang);
}

namespace {

// Key centres {"a": [x, y], ...} and a path [[x, y, t?], ...]; throws on bad data.
void parse_swipe(const json &keys_in, const json &path_in, std::map<gunichar, Point> &keys,
                 std::vector<Point> &path) {
    for (auto &[k, v] : keys_in.items())
        keys[g_unichar_tolower(g_utf8_get_char(k.c_str()))] = {v.at(0).get<double>(), v.at(1).get<double>()};
    for (auto &p : path_in)
        path.push_back({p.at(0).get<double>(), p.at(1).get<double>(), p.size() > 2 ? p.at(2).get<double>() : 0.0});
}

}  // namespace

int print_suggestions(const std::string &context, const std::string &lang) {
    Model &model = model_for(lang);
    gint64 t0 = g_get_monotonic_time();
    auto words = model.suggest(context, 3);
    gint64 t1 = g_get_monotonic_time();
    std::string fix = model.autocorrect(context, true);
    gint64 t2 = g_get_monotonic_time();
    for (const auto &w : words)
        g_print("suggest  %s\n", w.c_str());
    g_print("correct  %s\n", fix.empty() ? "(leave as typed)" : fix.c_str());
    g_print("took     %.1f ms + %.1f ms\n", static_cast<double>(t1 - t0) / 1000.0, static_cast<double>(t2 - t1) / 1000.0);
    return 0;
}

int swipe_bench(const std::string &file, const std::string &lang) {
    std::string text;
    if (!read_file(file, text)) {
        g_printerr("cannot read %s\n", file.c_str());
        return 1;
    }
    Model &model = model_for(lang);
    size_t total = 0, top1 = 0, top4 = 0;
    double ms = 0, worst_ms = 0;
    std::vector<std::string> misses;
    std::vector<std::pair<double, std::string>> slowest;
    size_t pos = 0;
    while (pos < text.size()) {
        size_t end = text.find('\n', pos);
        if (end == std::string::npos)
            end = text.size();
        std::string line = text.substr(pos, end - pos);
        pos = end + 1;
        if (trim(line).empty())
            continue;
        std::map<gunichar, Point> keys;
        std::vector<Point> path;
        std::string word, context;
        try {
            json j = json::parse(line);
            word = j.at("word").get<std::string>();
            context = j.value("context", "");
            parse_swipe(j.at("keys"), j.at("path"), keys, path);
        } catch (const std::exception &e) {
            g_printerr("skipping a bad line: %s\n", e.what());
            continue;
        }
        gint64 t0 = g_get_monotonic_time();
        auto got = model.swipe(context, keys, path, 4);
        double took = static_cast<double>(g_get_monotonic_time() - t0) / 1000.0;
        ms += took;
        worst_ms = std::max(worst_ms, took);
        slowest.push_back({took, word + " (" + std::to_string(path.size()) + " points)"});
        total++;
        auto same = [&](const std::string &w) { return fold(w) == fold(word); };
        if (std::any_of(got.begin(), got.end(), same))
            top4++;
        if (!got.empty() && same(got[0]))
            top1++;
        else
            misses.push_back(word + " -> " + (got.empty() ? "(nothing)" : got[0]));
    }
    if (total == 0) {
        g_printerr("no swipes in %s\n", file.c_str());
        return 1;
    }
    for (size_t i = 0; i < misses.size() && i < 40; i++)
        g_print("miss  %s\n", misses[i].c_str());
    std::sort(slowest.begin(), slowest.end(), [](auto &a, auto &b) { return a.first > b.first; });
    for (size_t i = 0; i < slowest.size() && i < 5; i++)
        g_print("slow  %.1f ms  %s\n", slowest[i].first, slowest[i].second.c_str());
    g_print("%zu swipes: top-1 %.1f%%, top-4 %.1f%%, %.1f ms average, %.1f ms worst\n", total,
            100.0 * static_cast<double>(top1) / static_cast<double>(total),
            100.0 * static_cast<double>(top4) / static_cast<double>(total), ms / static_cast<double>(total),
            worst_ms);
    return 0;
}

void init() {
    auto &svc = Service::get();
    svc.on("Suggest", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *context, *lang;
        guint32 max;
        g_variant_get(params, "(&s&su)", &context, &lang, &max);
        std::vector<std::string> words;
        if (setting_bool("suggestions-enabled", true))
            words = suggest(context, lang, max ? max : 3);
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE("as"));
        for (const auto &w : words)
            g_variant_builder_add(&b, "s", w.c_str());
        g_dbus_method_invocation_return_value(inv, g_variant_new("(as)", &b));
    });
    svc.on("SwipeWords", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *context, *lang, *keys_json, *path_json;
        guint32 max;
        g_variant_get(params, "(&s&s&s&su)", &context, &lang, &keys_json, &path_json, &max);
        std::map<gunichar, Point> keys;
        std::vector<Point> path;
        try {
            parse_swipe(json::parse(keys_json), json::parse(path_json), keys, path);
        } catch (const std::exception &e) {
            g_dbus_method_invocation_return_error(inv, G_DBUS_ERROR, G_DBUS_ERROR_INVALID_ARGS,
                                                  "bad swipe data: %s", e.what());
            return;
        }
        auto words = swipe(context, lang, keys, path, max ? max : 4);
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE("as"));
        for (const auto &w : words)
            g_variant_builder_add(&b, "s", w.c_str());
        g_dbus_method_invocation_return_value(inv, g_variant_new("(as)", &b));
    });
    svc.on("LogSwipe", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *entry;
        g_variant_get(params, "(&s)", &entry);
        if (setting_bool("swipe-log", false)) {
            try {
                std::string line = json::parse(entry).dump() + "\n";  // one line, whatever came in
                std::string path = join_path(data_dir(), "swipe-log.jsonl");
                if (FILE *f = fopen(path.c_str(), "a")) {
                    fwrite(line.data(), 1, line.size(), f);
                    fclose(f);
                }
            } catch (const std::exception &e) {
                g_warning("LogSwipe: bad entry: %s", e.what());
            }
        }
        reply_empty(inv);
    });
    svc.on("Autocorrect", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *context, *lang;
        g_variant_get(params, "(&s&s)", &context, &lang);
        reply_string(inv, model_for(lang).autocorrect(context, setting_bool("autocorrect", true)));
    });
    svc.on("SetKeyLayout", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *keys_json;
        g_variant_get(params, "(&s)", &keys_json);
        std::map<gunichar, Point> keys;
        try {
            json parsed = json::parse(keys_json);
            for (auto &[k, v] : parsed.items())
                keys[g_unichar_tolower(g_utf8_get_char(k.c_str()))] = {v.at(0).get<double>(), v.at(1).get<double>()};
        } catch (const std::exception &e) {
            g_dbus_method_invocation_return_error(inv, G_DBUS_ERROR, G_DBUS_ERROR_INVALID_ARGS,
                                                  "bad key layout: %s", e.what());
            return;
        }
        // Fewer keys than a letter row: a symbols page, not worth keeping.
        if (keys.size() >= 10)
            normalise_rows(keys, g_layout);
        reply_empty(inv);
    });
    svc.on("AcceptWord", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *word;
        g_variant_get(params, "(&s)", &word);
        model_for("").accept(word);
        reply_empty(inv);
    });
    svc.on("LearnText", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *text, *lang;
        g_variant_get(params, "(&s&s)", &text, &lang);
        learn(text, lang);
        reply_empty(inv);
    });
    svc.on("ForgetWord", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *word;
        g_variant_get(params, "(&s)", &word);
        model_for("").forget(word);
        reply_empty(inv);
    });
}

}  // namespace nkb::predict
