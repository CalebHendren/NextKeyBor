#!/usr/bin/env bash
# Sets up GroqType's command-line tool for NextKeyBor's dictation, without
# GroqType's own hotkey daemon (which needs root for keyd and ydotool).
# `groqtype transcribe` only needs Python's standard library.
#
#   tools/setup-groqtype.sh          asks for a Groq API key (input hidden)
#   GROQ_API_KEY=... tools/setup-groqtype.sh
#
# Skips the download when a groqtype command already exists (for example a
# full GroqType install); the API key is stored in GroqType's own config.
set -euo pipefail

repo=${GROQTYPE_REPO:-https://github.com/dixonSolutions/GroqType.git}
# A reviewed commit (the merge of dixonSolutions/GroqType#8, which added
# `transcribe`), not whatever the branch holds today. Bump it deliberately.
ref=${GROQTYPE_REF:-aa75063a1a0a23a0218990e63dcf48b76e87b2d0}
dir="${XDG_DATA_HOME:-$HOME/.local/share}/nextkeybor/GroqType"
bin="$HOME/.local/bin/groqtype"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

groqtype=$(command -v groqtype || true)
[[ -z $groqtype && -x $bin ]] && groqtype=$bin
# Our own wrapper is brought to the pinned commit; anyone else's is left alone.
if [[ -z $groqtype ]] || grep -qF "$dir/groqtype.py" "$groqtype" 2>/dev/null; then
    say "Downloading GroqType ${ref:0:12} to $dir"
    [[ -d $dir/.git ]] || git init -q "$dir"
    git -C "$dir" fetch -q --depth 1 "$repo" "$ref"
    git -C "$dir" checkout -q --detach FETCH_HEAD
    mkdir -p "$(dirname "$bin")"
    printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$dir/groqtype.py" > "$bin"
    chmod +x "$bin"
    groqtype=$bin
fi

if ! "$groqtype" transcribe --help > /dev/null 2>&1; then
    echo "This GroqType has no 'transcribe' command yet (it comes with dixonSolutions/GroqType#8)." >&2
    echo "Dictation keeps using the local model until GroqType is updated." >&2
fi

key=${GROQ_API_KEY:-}
if [[ -z $key && -t 0 ]]; then
    read -rsp "Groq API key (free at https://console.groq.com/keys; Enter to skip): " key
    echo
fi
if [[ -n $key ]]; then
    # Not `groqtype config api-key KEY`: a command line is visible to every
    # user on the machine. Let GroqType create its config, then add the key.
    "$groqtype" config-show > /dev/null
    printf '%s' "$key" | python3 -c '
import json, os, sys
path = os.path.expanduser("~/.config/groqtype/config.json")
with open(path) as f:
    cfg = json.load(f)
cfg["api_key"] = sys.stdin.read().strip()
fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2)
os.replace(path + ".tmp", path)
'
    say "Groq API key saved in GroqType's config"
else
    echo "Add a Groq API key (free at https://console.groq.com/keys) in NextKeyBor's settings,"
    echo "or run this script again."
fi
