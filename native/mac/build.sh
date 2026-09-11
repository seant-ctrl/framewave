#!/usr/bin/env bash
# Builds the fw-sysaudio helper (ScreenCaptureKit system-audio capture) as a
# universal binary. Run on macOS with Xcode command line tools installed.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
FLAGS=(-O -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework Foundation)
swiftc "${FLAGS[@]}" -target arm64-apple-macos13.0 -o build/fw-sysaudio-arm64 sysaudio.swift
swiftc "${FLAGS[@]}" -target x86_64-apple-macos13.0 -o build/fw-sysaudio-x64 sysaudio.swift
lipo -create build/fw-sysaudio-arm64 build/fw-sysaudio-x64 -output build/fw-sysaudio
rm -f build/fw-sysaudio-arm64 build/fw-sysaudio-x64
chmod +x build/fw-sysaudio
codesign --force --sign - build/fw-sysaudio
echo "built $(pwd)/build/fw-sysaudio"
lipo -info build/fw-sysaudio
