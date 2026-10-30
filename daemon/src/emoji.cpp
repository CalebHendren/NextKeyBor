#include "emoji.h"

#include <algorithm>
#include <map>
#include <regex>
#include <set>

#include "dbus_service.h"
#include "predict.h"
#include "util.h"

namespace nkb::emoji {

namespace {

// Fedora's cldr-emoji-annotation, Debian/Ubuntu's unicode-cldr-core;
// NKB_CLDR_DIR overrides it (for testing).
const char *cldr_dir() {
    const char *dir = g_getenv("NKB_CLDR_DIR");
    return dir && *dir ? dir : "/usr/share/unicode/cldr/common";
}
constexpr size_t kMaxRecent = 48;

struct Emoji {
    std::string emoji;               // display form (with U+FE0F where needed)
    std::string name;                // localized name
    std::string name_folded;
    std::vector<std::string> keywords;  // folded, all languages loaded
    int order;                       // CLDR file order, stable tiebreak
};

// Popular defaults for an empty query before anything has been used.
const char *kPopular[] = {"😂", "❤️", "🤣", "👍", "😭", "🙏", "😘", "🥰", "😍", "😊", "🎉", "😁",
                          "💕", "🥺", "😅", "🔥", "☺️", "🤦", "♥️", "🤷", "🙄", "😆", "🤗", "😉",
                          "🎂", "🤔", "👏", "🙂", "😳", "🥳", "😎", "👌", "💜", "😔", "💪", "✨",
                          "💖", "👀", "😋", "😏", "😢", "👉", "💗", "😩", "💯", "🌹", "💞", "🎈"};

int popular_rank(const std::string &emoji) {
    for (size_t i = 0; i < std::size(kPopular); i++)
        if (emoji == kPopular[i])
            return static_cast<int>(i);
    return -1;
}

bool is_emoji_cp(gunichar c) {
    return c >= 0x1F000 || (c >= 0x2600 && c <= 0x27BF) || (c >= 0x2B00 && c <= 0x2BFF) ||
           (c >= 0x2300 && c <= 0x23FF) || c == 0x203C || c == 0x2049 || c == 0x2122 ||
           c == 0x2139 || (c >= 0x2194 && c <= 0x21AA) || c == 0x24C2 || c == 0x25AA ||
           c == 0x25AB || c == 0x25B6 || c == 0x25C0 || (c >= 0x25FB && c <= 0x25FE) ||
           c == 0x2934 || c == 0x2935 || c == 0x3030 || c == 0x303D || c == 0x3297 || c == 0x3299 ||
           c == 0xA9 || c == 0xAE;
}

bool has_skin_tone(const std::string &s) {
    for (const gchar *p = s.c_str(); *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);
        if (c >= 0x1F3FB && c <= 0x1F3FF)
            return g_utf8_strlen(s.c_str(), -1) > 1;  // the tone swatches themselves are fine
    }
    return false;
}

// CLDR strips U+FE0F; single text-default code points need it to render as emoji.
std::string display_form(const std::string &cp) {
    if (g_utf8_strlen(cp.c_str(), -1) != 1)
        return cp;
    gunichar c = g_utf8_get_char(cp.c_str());
    if (c < 0x1F000)
        return cp + "\xEF\xB8\x8F";
    return cp;
}

std::string unescape_xml(std::string s) {
    static const std::pair<const char *, const char *> ents[] = {
        {"&amp;", "&"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", "\""}, {"&apos;", "'"}};
    for (auto &[from, to] : ents) {
        size_t pos;
        while ((pos = s.find(from)) != std::string::npos)
            s.replace(pos, strlen(from), to);
    }
    return s;
}

struct Db {
    std::vector<Emoji> emojis;           // emoji-only
    std::vector<Emoji> symbols;          // non-emoji CLDR entries (used by symbol search)
    std::map<std::string, size_t> index; // cp -> emojis index
    std::map<std::string, size_t> sym_index;
    std::set<std::string> langs;
};

Db g_db;
std::vector<std::string> g_recent;
bool g_recent_loaded = false;

std::string recent_path() {
    return join_path(data_dir(), "emoji-recent.json");
}

void load_file(const std::string &path, bool derived) {
    std::string text;
    if (!read_file(path, text))
        return;
    static const std::regex re(R"re(<annotation cp="([^"]+)"( type="tts")?>([^<]*)</annotation>)re");
    for (auto it = std::sregex_iterator(text.begin(), text.end(), re); it != std::sregex_iterator(); ++it) {
        std::string cp = unescape_xml((*it)[1]);
        bool tts = (*it)[2].matched;
        std::string value = unescape_xml((*it)[3]);
        if (derived && has_skin_tone(cp))
            continue;
        bool emoji = is_emoji_cp(g_utf8_get_char(cp.c_str())) || g_utf8_strlen(cp.c_str(), -1) > 1;
        auto &list = emoji ? g_db.emojis : g_db.symbols;
        auto &index = emoji ? g_db.index : g_db.sym_index;
        auto found = index.find(cp);
        if (found == index.end()) {
            list.push_back(Emoji{emoji ? display_form(cp) : cp, "", "", {}, static_cast<int>(list.size())});
            found = index.emplace(cp, list.size() - 1).first;
        }
        Emoji &e = list[found->second];
        if (tts) {
            if (e.name.empty()) {  // first loaded language (the user's) wins
                e.name = value;
                e.name_folded = fold(value);
            } else {
                e.keywords.push_back(fold(value));
            }
        } else {
            size_t start = 0;
            while (start <= value.size()) {
                size_t bar = value.find('|', start);
                std::string kw = trim(value.substr(start, bar == std::string::npos ? std::string::npos : bar - start));
                if (!kw.empty())
                    e.keywords.push_back(fold(kw));
                if (bar == std::string::npos)
                    break;
                start = bar + 1;
            }
        }
    }
}

void ensure_lang(const std::string &lang) {
    if (g_db.langs.count(lang))
        return;
    g_db.langs.insert(lang);
    for (const char *sub : {"annotations", "annotationsDerived"})
        load_file(join_path(join_path(cldr_dir(), sub), lang + ".xml"), sub[11] == 'D');
}

void ensure_loaded() {
    std::string active = predict::active_language();
    std::string short_code = active.substr(0, active.find('_'));
    // User's language first so its names are shown, English always searchable too.
    ensure_lang(short_code);
    if (active != short_code)
        ensure_lang(active);
    ensure_lang("en");
    if (!g_recent_loaded) {
        g_recent_loaded = true;
        json j = load_json(recent_path(), json::array());
        for (const auto &e : j)
            if (e.is_string())
                g_recent.push_back(e.get<std::string>());
    }
}

std::vector<std::string> tokens_of(const std::string &q) {
    std::vector<std::string> out;
    for (const auto &w : split_words(fold(q)))
        out.push_back(w);
    if (out.empty() && !trim(q).empty())
        out.push_back(fold(trim(q)));  // e.g. searching for ":)" or a pasted emoji
    return out;
}

json entry_json(const Emoji &e) {
    return {{"emoji", e.emoji}, {"name", e.name}};
}

std::string search(const std::string &query, unsigned max) {
    ensure_loaded();
    max = std::clamp(max ? max : 60u, 1u, 500u);
    json out = json::array();
    auto toks = tokens_of(query);
    if (toks.empty()) {
        std::set<std::string> seen;
        auto push = [&](const std::string &s) {
            if (out.size() >= max || !seen.insert(s).second)
                return;
            std::string bare = s;
            if (bare.size() > 3 && bare.compare(bare.size() - 3, 3, "\xEF\xB8\x8F") == 0)
                bare.resize(bare.size() - 3);
            auto it = g_db.index.find(bare);
            out.push_back(it != g_db.index.end() ? entry_json(g_db.emojis[it->second])
                                                 : json{{"emoji", s}, {"name", ""}});
        };
        for (const auto &r : g_recent)
            push(r);
        for (const char *p : kPopular)
            push(p);
        for (const auto &e : g_db.emojis)
            push(e.emoji);
        return out.dump();
    }
    std::vector<std::pair<int, const Emoji *>> hits;
    for (const auto &e : g_db.emojis) {
        int s = match_score(toks, e.name_folded, e.keywords);
        if (s > 0) {
            if (std::find(g_recent.begin(), g_recent.end(), e.emoji) != g_recent.end())
                s += 150;
            else if (popular_rank(e.emoji) >= 0)
                s += 150 - popular_rank(e.emoji);
            hits.emplace_back(s, &e);
        }
    }
    std::stable_sort(hits.begin(), hits.end(), [](auto &a, auto &b) {
        if (a.first != b.first)
            return a.first > b.first;
        return a.second->order < b.second->order;
    });
    for (size_t i = 0; i < hits.size() && out.size() < max; i++)
        out.push_back(entry_json(*hits[i].second));
    return out.dump();
}

// The emoji for a finished word, for the suggestion bar: one named after it
// ("pizza"), else the most used or most popular one tagged with it
// ("happy"), trying the singular too ("dogs"). Empty when there is none.
std::string for_word(const std::string &word) {
    if (g_utf8_strlen(word.c_str(), -1) < 3)
        return "";
    ensure_loaded();
    std::string key = fold(word);
    std::vector<std::string> keys{key};
    if (key.size() > 3 && key.back() == 's')
        keys.push_back(key.substr(0, key.size() - 1));
    for (const auto &k : keys) {
        for (const auto &e : g_db.emojis)
            if (e.name_folded == k)
                return e.emoji;
        const Emoji *best = nullptr;
        long best_rank = 0;
        for (const auto &e : g_db.emojis) {
            if (std::find(e.keywords.begin(), e.keywords.end(), k) == e.keywords.end())
                continue;
            // Recent first, then popular, then CLDR order.
            auto recent = std::find(g_recent.begin(), g_recent.end(), e.emoji);
            long rank = recent != g_recent.end() ? recent - g_recent.begin()
                        : popular_rank(e.emoji) >= 0 ? 1000 + popular_rank(e.emoji)
                                                     : 100000 + e.order;
            if (!best || rank < best_rank) {
                best = &e;
                best_rank = rank;
            }
        }
        if (best)
            return best->emoji;
    }
    return "";
}

void note_used(const std::string &emoji) {
    ensure_loaded();
    g_recent.erase(std::remove(g_recent.begin(), g_recent.end(), emoji), g_recent.end());
    g_recent.insert(g_recent.begin(), emoji);
    if (g_recent.size() > kMaxRecent)
        g_recent.resize(kMaxRecent);
    save_json(recent_path(), g_recent);
}

}  // namespace

int match_score(const std::vector<std::string> &toks, const std::string &name,
                const std::vector<std::string> &keywords) {
    if (toks.empty())
        return 0;
    int total = 0;
    auto word_prefix = [](const std::string &hay, const std::string &needle) {
        for (size_t pos = hay.find(needle); pos != std::string::npos; pos = hay.find(needle, pos + 1))
            if (pos == 0 || hay[pos - 1] == ' ' || hay[pos - 1] == '-' || hay[pos - 1] == ':')
                return true;
        return false;
    };
    for (const auto &t : toks) {
        int best = 0;
        if (name == t)
            best = 100;
        else if (name.compare(0, t.size(), t) == 0)
            best = 70;
        else if (word_prefix(name, t))
            best = 50;
        for (const auto &k : keywords) {
            if (k == t)
                best = std::max(best, 60);
            else if (k.compare(0, t.size(), t) == 0)
                best = std::max(best, 35);
            else if (t.size() >= 3 && word_prefix(k, t))
                best = std::max(best, 20);
        }
        if (best == 0)
            return 0;  // every token must match something
        total += best;
    }
    // Shorter names are usually the more canonical result ("heart" before "heart with arrow").
    return total * 10 - static_cast<int>(std::min<size_t>(name.size(), 60)) / 3;
}

// Exposed so symbols.cpp can include CLDR's names for non-emoji characters.
std::vector<std::pair<std::string, std::pair<std::string, std::vector<std::string>>>> cldr_symbols() {
    ensure_loaded();
    std::vector<std::pair<std::string, std::pair<std::string, std::vector<std::string>>>> out;
    for (const auto &s : g_db.symbols)
        out.push_back({s.emoji, {s.name_folded, s.keywords}});
    return out;
}

void init() {
    auto &svc = Service::get();
    svc.on("SearchEmoji", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *q;
        guint32 max;
        g_variant_get(params, "(&su)", &q, &max);
        reply_string(inv, search(q, max));
    });
    svc.on("NoteEmojiUsed", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *e;
        g_variant_get(params, "(&s)", &e);
        note_used(e);
        reply_empty(inv);
    });
    svc.on("EmojiForWord", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *word;
        g_variant_get(params, "(&s)", &word);
        reply_string(inv, for_word(word));
    });
    svc.on("SearchSymbols", [](GVariant *params, GDBusMethodInvocation *inv) {
        const gchar *q;
        guint32 max;
        g_variant_get(params, "(&su)", &q, &max);
        reply_string(inv, symbols::search(q, max));
    });
}

}  // namespace nkb::emoji
