#!/bin/bash
# Builds build/GundamPet.app from Sources/ and units/ (run tools/build_units.py first when assets change).
set -euo pipefail
cd "$(dirname "$0")"

APP=build/GundamPet.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target arm64-apple-macos13 \
    -o "$APP/Contents/MacOS/GundamPet" $(find Sources -name '*.swift' | sort)
cp Info.plist "$APP/Contents/Info.plist"
cp -R units "$APP/Contents/Resources/units"
# the app icon (made by tools/make_icon.py from Cross Rays' own frames)
cp assets/icon/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# each character's own settings (size, wandering): the settings panel lays the user's changes over these
cp -R characters "$APP/Contents/Resources/characters"
codesign --force --sign - "$APP" >/dev/null
echo "built $APP"
