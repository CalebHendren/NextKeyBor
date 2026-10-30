// GIFs and stickers: online search (GIPHY, KLIPY, Openverse), local cache,
// favourites that work offline, and the user's own imported library.
#pragma once

#include <string>

namespace nkb::media {

void init();  // registers D-Bus methods, prunes the cache

// The provider searches go to: the chosen one, or Openverse until it has a key.
std::string effective_provider();

}  // namespace nkb::media
