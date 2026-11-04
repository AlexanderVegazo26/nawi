#!/usr/bin/env bash
# Rebuilds sample.apk from sample/AndroidManifest.xml with the Android SDK's aapt2, so the APK reader is tested
# against the binary manifest format the real toolchain writes, not one this repo encodes itself.
# Usage: ANDROID_HOME=~/Android/Sdk src/main/mobile/fixtures/build-fixture.sh   (needs python3 for the zip step)
# Safe to rerun: it overwrites sample.apk. Commit the result together with any manifest change.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sdk="${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"
aapt2="$(ls -d "$sdk"/build-tools/*/aapt2 | sort -V | tail -1)"
jar="$(ls -d "$sdk"/platforms/android-*/android.jar | sort -V | tail -1)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$aapt2" link --manifest "$here/sample/AndroidManifest.xml" -I "$jar" -o "$tmp/base.apk"
# Native libraries for two ABIs (empty .so stand-ins: the reader only looks at the entry names), deflated, plus a
# stored entry, so both zip methods are exercised. Fixed timestamps keep the file byte-identical across rebuilds.
python3 - "$tmp/base.apk" "$here/sample.apk" <<'PY'
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
    for info in zin.infolist():
        data = zin.read(info)
        out = zipfile.ZipInfo(info.filename, date_time=(2026, 1, 1, 0, 0, 0))
        out.compress_type = zipfile.ZIP_DEFLATED
        zout.writestr(out, data)
    for name, method in (("lib/arm64-v8a/libsample.so", zipfile.ZIP_DEFLATED),
                         ("lib/x86_64/libsample.so", zipfile.ZIP_STORED),
                         ("assets/readme.txt", zipfile.ZIP_STORED)):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = method
        zout.writestr(info, b"\x7fELF stand-in")
PY
echo "wrote $here/sample.apk ($(stat -c %s "$here/sample.apk") bytes, aapt2 $("$aapt2" version 2>&1 | head -1), $(basename "$(dirname "$jar")"))"
