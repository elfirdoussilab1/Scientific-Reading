#!/usr/bin/env python3
"""Run your paper library locally.

    python3 serve.py            # http://localhost:8642, opens it in Google Chrome
    python3 serve.py --port 9000 --no-browser
    python3 serve.py --idle-exit 900   # stop after 15 min without the page open

Serves the app and saves every edit straight to data/library.json, keeping
timestamped backups in data/.backups/. Only listens on 127.0.0.1.
No dependencies beyond the Python standard library.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "library.json"  # personal, git-ignored
EXAMPLE = ROOT / "data" / "example-library.json"  # shown until you save your first change
BACKUPS = ROOT / "data" / ".backups"
KEEP_BACKUPS = 50
BACKUP_EVERY = 10 * 60  # seconds between two backups

_lock = threading.Lock()
_last_backup = 0.0
_last_seen = time.monotonic()  # monotonic: time asleep does not count as idle


def backup():
    global _last_backup
    if not DATA.exists() or time.time() - _last_backup < BACKUP_EVERY:
        return
    BACKUPS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(DATA, BACKUPS / time.strftime("library-%Y%m%d-%H%M%S.json"))
    _last_backup = time.time()
    for old in sorted(BACKUPS.glob("library-*.json"))[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)


def write_atomic(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".library-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def handle_one_request(self):
        global _last_seen
        _last_seen = time.monotonic()
        super().handle_one_request()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _same_origin(self):
        origin = self.headers.get("Origin")
        return origin is None or urlsplit(origin).netloc == self.headers.get("Host")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/status":
            return self._json(200, {"app": "exlibris", "mode": "local", "file": str(DATA.relative_to(ROOT))})
        if path == "/api/library":
            src = DATA if DATA.exists() else EXAMPLE
            body = src.read_bytes() if src.exists() else b'{"version":1,"topics":[],"papers":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/data/.backups"):
            return self._json(404, {"error": "not found"})
        return super().do_GET()

    def do_PUT(self):
        if urlsplit(self.path).path != "/api/library":
            return self._json(404, {"error": "not found"})
        if not self._same_origin():
            return self._json(403, {"error": "cross-origin write refused"})
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("papers"), list):
                raise ValueError("not a library")
        except (ValueError, UnicodeDecodeError) as e:
            return self._json(400, {"error": f"invalid library: {e}"})
        with _lock:
            backup()
            write_atomic(DATA, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        self.log_message("saved %s (%d papers)", DATA.relative_to(ROOT), len(data["papers"]))
        return self._json(200, {"ok": True})

    def log_message(self, fmt, *args):
        # Keep the console quiet: only report saves and errors.
        if fmt.startswith("saved") or (len(args) > 1 and str(args[1])[:1] in "45"):
            sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {fmt % args}\n")


def open_in_chrome(url):
    """Open url in a Google Chrome tab, or in the default browser without Chrome."""
    if sys.platform == "darwin":
        if subprocess.run(["open", "-a", "Google Chrome", url], capture_output=True).returncode == 0:
            return
    else:
        try:
            if webbrowser.get("chrome").open(url):
                return
        except webbrowser.Error:
            pass
    webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8642)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--idle-exit", type=int, default=0, metavar="SECONDS",
                    help="stop after this long without requests (the open page pings every minute)")
    args = ap.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        sys.exit(f"Port {args.port} is already in use. Pick another one, e.g.  python3 serve.py --port {args.port + 1}")
    url = f"http://localhost:{args.port}/"
    print(f"📚  Your library is open at {url}\n    Edits are saved to {DATA.relative_to(ROOT)}. Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: open_in_chrome(url)).start()
    if args.idle_exit > 0:
        def watchdog():
            while True:
                time.sleep(15)
                if time.monotonic() - _last_seen > args.idle_exit:
                    print("No open library window for a while; stopping.")
                    server.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye — happy reading.")


if __name__ == "__main__":
    main()
