#!/bin/bash
# Installs "Scientific Reading" as a desktop app on Linux (Fedora, and other
# freedesktop desktops such as GNOME or KDE): it appears in the app grid / menu
# and can be pinned to the dock.
#
#   ./app/install-linux-app.sh               # install for the current user
#   ./app/install-linux-app.sh --uninstall   # remove it again
#
# The app starts serve.py in the background (if it isn't already running) and
# opens the library in a Google Chrome tab (Chromium, or the default browser,
# if Chrome isn't installed). The server stops by itself ~15 minutes after the
# last library tab is closed. Re-run this script if you move the repo.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SCIENTIFIC_READING_PORT:-8642}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
APP_DIR="$DATA_HOME/scientific-reading"
DESKTOP="$DATA_HOME/applications/scientific-reading.desktop"
ICON="$DATA_HOME/icons/hicolor/512x512/apps/scientific-reading.png"

refresh_menus() {
  command -v update-desktop-database >/dev/null && update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$APP_DIR" "$STATE_HOME/scientific-reading"
  rm -f "$DESKTOP" "$ICON"
  refresh_menus
  echo "Removed Scientific Reading. Your library (data/library.json in $REPO) was not touched."
  exit 0
fi

PY="$(command -v python3 || true)"
if [[ -z "$PY" ]]; then
  echo "python3 not found. Install it first:  sudo dnf install python3" >&2
  exit 1
fi

echo "Installing Scientific Reading for $USER"
mkdir -p "$APP_DIR" "$(dirname "$DESKTOP")" "$(dirname "$ICON")"

# --- icon --------------------------------------------------------------------
# 512 px is plenty for menus and docks; fall back to the full-size PNG.
if command -v magick >/dev/null; then
  magick "$REPO/app/icon.png" -resize 512x512 "$ICON"
elif command -v convert >/dev/null; then
  convert "$REPO/app/icon.png" -resize 512x512 "$ICON"
else
  cp "$REPO/app/icon.png" "$ICON"
fi

# --- launcher ----------------------------------------------------------------
cat > "$APP_DIR/launch" <<LAUNCH
#!/bin/bash
REPO="$REPO"
PY="$PY"
PORT=$PORT
URL="http://localhost:\$PORT/"
LOG="$STATE_HOME/scientific-reading/server.log"

alert() {
  if command -v notify-send >/dev/null; then notify-send -a "Scientific Reading" -i scientific-reading "Scientific Reading" "\$1"
  elif command -v zenity >/dev/null; then zenity --error --title="Scientific Reading" --text="\$1"
  else echo "\$1" >&2; fi
}
running() {
  "\$PY" - "\${URL}api/status" <<'PYCHECK' 2>/dev/null
import sys, urllib.request
sys.exit(0 if b"exlibris" in urllib.request.urlopen(sys.argv[1], timeout=1).read() else 1)
PYCHECK
}

if ! running; then
  if [[ ! -f "\$REPO/serve.py" ]]; then
    alert "The library folder was not found at \$REPO. If you moved it, run app/install-linux-app.sh again from its new location."
    exit 1
  fi
  mkdir -p "\$(dirname "\$LOG")"
  echo "--- \$(date) starting server" >> "\$LOG"
  cd "\$REPO" && setsid nohup "\$PY" serve.py --port \$PORT --no-browser --idle-exit 900 >> "\$LOG" 2>&1 < /dev/null &
  for _ in \$(seq 1 60); do running && break; sleep 0.1; done
  if ! running; then
    alert "The library server did not start (is port \$PORT used by another program?). Details: \$LOG"
    exit 1
  fi
fi

# Open in a Google Chrome tab; then Chromium; then the default browser.
for b in google-chrome google-chrome-stable chromium-browser chromium; do
  if command -v "\$b" >/dev/null; then exec "\$b" "\$URL"; fi
done
for app in com.google.Chrome org.chromium.Chromium; do
  if command -v flatpak >/dev/null && flatpak info "\$app" >/dev/null 2>&1; then exec flatpak run "\$app" "\$URL"; fi
done
exec xdg-open "\$URL"
LAUNCH
chmod +x "$APP_DIR/launch"

# --- menu entry --------------------------------------------------------------
cat > "$DESKTOP" <<ENTRY
[Desktop Entry]
Type=Application
Name=Scientific Reading
GenericName=Paper library
Comment=Your research papers, summaries and LaTeX notes
Exec="$APP_DIR/launch"
Icon=scientific-reading
Terminal=false
Categories=Office;Education;Science;
Keywords=papers;research;notes;latex;arxiv;
StartupNotify=false
ENTRY
chmod +x "$DESKTOP"
refresh_menus

echo "Done. Open \"Scientific Reading\" from your app grid (press Super and type its name)."
echo "Tip: right-click it in the dock and choose \"Pin to Dash\" to keep it one click away."
