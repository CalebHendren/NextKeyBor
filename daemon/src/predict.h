// Word completion, correction and next-word prediction.
//
// Vocabulary comes from the installed hunspell dictionary for the language,
// ranked by the FrequencyWords list (downloaded once per language), and is
// boosted by what the user actually types (unigrams + bigrams, stored locally).
#pragma once

#include <glib.h>

#include <map>
#include <string>
#include <vector>

namespace nkb::predict {

void init();  // registers D-Bus methods
std::string active_language();
void set_active_language(const std::string &code);
std::vector<std::string> suggest(const std::string &context, const std::string &lang, unsigned max);

// Swipe (gesture) typing. Key centres and the finger path share one
// coordinate system in which a letter key is 1 unit wide; t is the time of a
// path point in milliseconds (0 when unknown).
struct Point {
    double x, y;
    double t = 0;
};
std::vector<std::string> swipe(const std::string &context, const std::string &lang,
                               const std::map<gunichar, Point> &keys, const std::vector<Point> &path,
                               unsigned max);
// Prints the suggestions and autocorrection for context; returns 0.
int print_suggestions(const std::string &context, const std::string &lang);
// Runs the swipes in a JSON-lines file ({"word", "keys", "path", "context"?})
// through the matcher and prints how many came out right; returns 0.
int swipe_bench(const std::string &file, const std::string &lang);
void learn(const std::string &text, const std::string &lang);
// Drops the cached vocabulary so a newly installed dictionary is picked up.
void reload(const std::string &lang);

}  // namespace nkb::predict
