#!/bin/bash
# Builds "Scientific Reading.app": a double-clickable launcher for the library.
#
#   ./app/install-mac-app.sh                 # installs into ~/Applications
#   ./app/install-mac-app.sh /Applications   # or anywhere else
#
# The app starts serve.py in the background (if it isn't already running) and
# opens the library in its own window. The server stops by itself ~15 minutes
# after the last library window is closed. Re-run this script if you move the repo.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/Scientific Reading.app"
PORT=8642
PY="$(command -v python3 || true)"

if [[ -z "$PY" ]]; then
  echo "python3 not found. Install Python 3 first (https://www.python.org/downloads/)." >&2
  exit 1
fi
PY="$(cd "$(dirname "$PY")" && pwd)/$(basename "$PY")"

echo "Building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- icon --------------------------------------------------------------------
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$REPO/app/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$REPO/app/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$ICONSET")"

# --- Info.plist --------------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Scientific Reading</string>
  <key>CFBundleDisplayName</key><string>Scientific Reading</string>
  <key>CFBundleIdentifier</key><string>io.github.scientific-reading.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# --- launcher ----------------------------------------------------------------
cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
REPO="$REPO"
PY="$PY"
PORT=$PORT
URL="http://localhost:\$PORT/"
LOG="\$HOME/Library/Logs/ScientificReading.log"

alert() { osascript -e "display alert \"Scientific Reading\" message \"\$1\" as critical" >/dev/null 2>&1; }
running() { curl -fs --max-time 1 "\${URL}api/status" 2>/dev/null | grep -q exlibris; }

if ! running; then
  if [[ ! -f "\$REPO/serve.py" ]]; then
    alert "The library folder was not found at \$REPO. If you moved it, run app/install-mac-app.sh again from its new location."
    exit 1
  fi
  echo "--- \$(date) starting server" >> "\$LOG"
  cd "\$REPO" && nohup "\$PY" serve.py --port \$PORT --no-browser --idle-exit 900 >> "\$LOG" 2>&1 &
  for _ in \$(seq 1 60); do running && break; sleep 0.1; done
  if ! running; then
    alert "The library server did not start (is port \$PORT used by another program?). Details: \$LOG"
    exit 1
  fi
fi

# Open in a clean app window (no tabs or address bar) when a Chromium browser is
# installed; otherwise use the default browser.
for b in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [[ -d "/Applications/\$b.app" || -d "\$HOME/Applications/\$b.app" ]]; then
    open -na "\$b" --args --app="\$URL"
    exit 0
  fi
done
open "\$URL"
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"

# Make Finder / Launchpad pick up the new icon.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

echo "Done. Open it from Spotlight (⌘Space → \"Scientific Reading\"), Launchpad, or $DEST."
echo "Tip: drag it to the Dock to keep it one click away."
