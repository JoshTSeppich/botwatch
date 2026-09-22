#!/bin/bash
# Renders build/icon.html to build/icon.icns. Needs Chrome, plus sips and
# iconutil, which ship with macOS. Re-run after editing the icon source.
set -e
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WORK=$(mktemp -d)
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --force-color-profile=srgb \
  --window-size=1024,1024 --screenshot="$WORK/icon-1024.png" \
  --virtual-time-budget=2000 "file://$PWD/build/icon.html" >/dev/null 2>&1

for size in 16 32 64 128 256 512; do
  sips -z $size $size "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size*2)) $((size*2)) "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$WORK/icon-1024.png" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o build/icon.icns
cp "$WORK/icon-1024.png" build/icon.png

# Menu bar icon. Lives under electron/ so it is packaged with the app; build/
# is build resources and does not ship.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --force-color-profile=srgb \
  --window-size=32,32 --screenshot="$WORK/tray@2x.png" \
  --virtual-time-budget=1500 "file://$PWD/build/tray.html" >/dev/null 2>&1
sips -z 16 16 "$WORK/tray@2x.png" --out electron/assets/trayTemplate.png >/dev/null
cp "$WORK/tray@2x.png" electron/assets/trayTemplate@2x.png

rm -rf "$WORK"
echo "wrote build/icon.icns, build/icon.png and electron/assets/trayTemplate*.png"
