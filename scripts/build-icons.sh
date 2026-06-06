#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
svg="$root/icons/icon.svg"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert not found. Install librsvg." >&2
  exit 1
fi

rsvg-convert -w 16 -h 16 "$svg" -o "$root/icons/icon16.png"
rsvg-convert -w 48 -h 48 "$svg" -o "$root/icons/icon48.png"
rsvg-convert -w 128 -h 128 "$svg" -o "$root/icons/icon128.png"

echo "icons ok"
