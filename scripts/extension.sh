#!/bin/sh
set -eu
DEST="${XMD_EXTENSION_DIR:-$HOME/xmd-extension}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL https://codeload.github.com/franklinjavier/xmd/tar.gz/refs/heads/main | tar -xz -C "$TMP" --strip-components=1
if [ ! -f "$TMP/extension/manifest.json" ]; then
  echo "xmd: extension/manifest.json missing from download" >&2
  exit 1
fi
rm -rf "$DEST.new"
cp -R "$TMP/extension" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
echo "Installed to $DEST"
echo "Open chrome://extensions"
echo "Turn on Developer mode"
echo "Click Load unpacked and choose $DEST"
echo "To update, run the same command again and click reload on the extension card."
