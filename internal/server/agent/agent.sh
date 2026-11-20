#!/bin/sh
# RiiMusic Discord agent for macOS and Linux. Needs python3 (on macOS it comes
# with the Command Line Tools; most Linux distributions have it).
# Shows what you play on RiiMusic as your Discord status ("Listening to ...").
#
#   curl -fsSL __SERVER__/agent.sh | sh
#
# The first run asks for the agent token (RiiMusic > Settings > Discord status)
# and keeps it in ~/.config/riimusic/agent-token, so later the command alone is
# enough. Keep the terminal open; Ctrl+C stops it and clears the status.
set -e
SERVER='__SERVER__'
DIR="${XDG_CONFIG_HOME:-$HOME/.config}/riimusic"
TOKEN_FILE="$DIR/agent-token"
TOKEN="${RIIMUSIC_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then TOKEN=$(cat "$TOKEN_FILE"); fi
if [ -z "$TOKEN" ]; then
  printf 'Agent token (RiiMusic > Settings > Discord status): ' >/dev/tty
  read -r TOKEN </dev/tty
fi
if [ -z "$TOKEN" ]; then echo "No token given." >&2; exit 1; fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is needed. macOS: run 'xcode-select --install'. Linux: install the python3 package." >&2
  exit 1
fi
mkdir -p "$DIR"
(umask 077 && printf '%s' "$TOKEN" >"$TOKEN_FILE")

PY=$(mktemp "${TMPDIR:-/tmp}/riimusic-agent.XXXXXX")
cat >"$PY" <<'PYEOF'
import json, os, socket, struct, sys, time, urllib.error, urllib.request, uuid

try:
    os.remove(__file__)  # the script lives in memory from here on
except OSError:
    pass
SERVER = os.environ["RIIMUSIC_SERVER"]
TOKEN_FILE = os.environ["RIIMUSIC_TOKEN_FILE"]
with open(TOKEN_FILE) as f:
    TOKEN = f.read().strip()


class ServerError(Exception):
    pass


def fetch():
    req = urllib.request.Request(SERVER + "/api/agent/nowplaying", headers={"Authorization": "Bearer " + TOKEN, "User-Agent": "riimusic-agent-sh"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise
    except (OSError, ValueError) as e:  # URLError, timeouts, bad JSON
        raise ServerError("Cannot reach RiiMusic: %s" % getattr(e, "reason", e))


def sockets():
    """Where the Discord desktop app (also Flatpak / Snap builds) puts its IPC socket."""
    dirs = [os.environ.get(k) for k in ("XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP")]
    if hasattr(os, "getuid"):
        dirs.append("/run/user/%d" % os.getuid())
    dirs.append("/tmp")
    for d in dirs:
        if not d:
            continue
        for sub in ("", "app/com.discordapp.Discord", "snap.discord", "app/dev.vencord.Vesktop"):
            for i in range(10):
                yield os.path.join(d, sub, "discord-ipc-%d" % i)


class Discord:
    """Discord IPC: frames of op (uint32 LE) + length (uint32 LE) + JSON."""

    def __init__(self, client_id):
        for path in sockets():
            if not os.path.exists(path):
                continue
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(10)
            try:
                s.connect(path)
            except OSError:
                s.close()
                continue
            self.s = s
            self.send(0, {"v": 1, "client_id": client_id})
            _, data = self.recv()
            if data.get("evt") != "READY":
                s.close()
                raise RuntimeError("Discord refused the connection: %s (check the Discord Application ID)" % data.get("message"))
            return
        raise RuntimeError("Discord desktop is not running.")

    def send(self, op, obj):
        b = json.dumps(obj).encode("utf-8")
        self.s.sendall(struct.pack("<II", op, len(b)) + b)

    def read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.s.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Discord closed the connection")
            buf += chunk
        return buf

    def recv(self):
        op, n = struct.unpack("<II", self.read(8))
        return op, (json.loads(self.read(n).decode("utf-8")) if n else {})

    def set_activity(self, act):
        self.send(1, {"cmd": "SET_ACTIVITY", "nonce": uuid.uuid4().hex, "args": {"pid": os.getpid(), "activity": act}})
        _, data = self.recv()
        if data.get("evt") == "ERROR":
            raise RuntimeError("Discord: %s" % (data.get("data") or {}).get("message"))

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def clip(s, n):
    s = s or ""
    if len(s) < 2:
        return s + "  "  # Discord wants at least 2 characters
    return s if len(s) <= n else s[: n - 1] + "…"


def main():
    print("RiiMusic Discord agent - %s (Ctrl+C to stop)" % SERVER, flush=True)
    dc, shown, last_err = None, "", ""
    try:
        while True:
            try:
                res = fetch()
                client_id = res.get("discordClientId") or ""
                if not client_id:
                    raise RuntimeError("The admin has not set a Discord Application ID on this server yet.")
                if dc is None:
                    dc = Discord(client_id)
                    print("Connected to Discord.", flush=True)
                    shown = ""
                np = res.get("nowPlaying")
                act, key = None, "none"
                if np and np.get("playing"):
                    start = int(time.time()) - int(np.get("positionMs", 0)) // 1000
                    ts = {"start": start}
                    if np.get("durationMs"):
                        ts["end"] = start + int(np["durationMs"]) // 1000
                    act = {
                        "type": 2,  # Listening
                        "details": clip(np.get("title"), 128),
                        "state": clip(np.get("artist") or "RiiMusic", 128),
                        "timestamps": ts,
                        "assets": {"large_image": np.get("coverUrl") or "vang", "large_text": clip(np.get("album") or np.get("title"), 128)},
                    }
                    key = "%s|%d" % (np.get("trackId"), start // 5)  # sent again after a seek
                if key != shown:
                    dc.set_activity(act)
                    shown = key
                    print(("Showing: %s - %s" % (np.get("title"), np.get("artist"))) if act else "Cleared (nothing playing).", flush=True)
                last_err = ""
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    try:
                        os.remove(TOKEN_FILE)
                    except OSError:
                        pass
                    print("The token is wrong or was replaced. Make a new one in RiiMusic, then run the command again.", flush=True)
                    return 1
                msg = "RiiMusic answered %s" % e.code
                if msg != last_err:
                    print(msg, flush=True)
                    last_err = msg
            except ServerError as e:
                msg = str(e)
                if msg != last_err:
                    print(msg, flush=True)
                    last_err = msg
            except (OSError, RuntimeError, ValueError) as e:
                if dc is not None:
                    dc.close()
                    dc = None  # reconnect next time
                if str(e) != last_err:
                    print(e, flush=True)
                    last_err = str(e)
            time.sleep(5)
    except KeyboardInterrupt:
        pass
    finally:
        if dc is not None:
            try:
                dc.set_activity(None)
            except Exception:
                pass
            dc.close()
    return 0


sys.exit(main())
PYEOF
RIIMUSIC_SERVER="$SERVER" RIIMUSIC_TOKEN_FILE="$TOKEN_FILE" exec python3 -u "$PY"
