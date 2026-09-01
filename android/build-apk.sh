#!/usr/bin/env bash
# Builds the Telecall Bridge debug APK.
#
#   cd ~/Desktop/Telecall && ./android/build-apk.sh
#
# Needs the Android SDK (Android Studio installs it) and a JDK. Gradle is downloaded
# automatically if you don't already have it.
set -uo pipefail
cd "$(dirname "$0")"

GRADLE_VERSION=8.9
say()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- Android SDK
if [ -z "${ANDROID_HOME:-}" ]; then
  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" \
                   "/usr/local/share/android-sdk" "/opt/homebrew/share/android-sdk"; do
    if [ -d "$candidate" ]; then export ANDROID_HOME="$candidate"; break; fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] || die "Android SDK not found.
  Install Android Studio (it downloads the SDK on first run), or set ANDROID_HOME
  to an existing SDK directory and run this again."
say "Android SDK: $ANDROID_HOME"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > local.properties

# ----------------------------------------------------------------------- JDK
if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
                   "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [ -x "$candidate/bin/javac" ]; then export JAVA_HOME="$candidate"; break; fi
  done
fi
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 17+ 2>/dev/null)"
fi
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
  say "JDK: $JAVA_HOME"
elif command -v javac > /dev/null; then
  say "JDK: $(command -v javac)"
else
  die "No JDK found.
  Install Android Studio (it bundles one), or: brew install --cask temurin"
fi

# -------------------------------------------------------------------- Gradle
GRADLE=""
if [ -x ./gradlew ]; then
  GRADLE="./gradlew"
elif command -v gradle > /dev/null; then
  GRADLE="gradle"
else
  CACHED="$HOME/.telecall-build/gradle-$GRADLE_VERSION/bin/gradle"
  if [ ! -x "$CACHED" ]; then
    say "Downloading Gradle $GRADLE_VERSION (one time, about 130 MB)…"
    mkdir -p "$HOME/.telecall-build"
    curl -fL --progress-bar \
      "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" \
      -o "$HOME/.telecall-build/gradle.zip" \
      || die "Could not download Gradle. Check your internet connection, or: brew install gradle"
    unzip -q -o "$HOME/.telecall-build/gradle.zip" -d "$HOME/.telecall-build" \
      || die "Could not unpack the Gradle download."
    rm -f "$HOME/.telecall-build/gradle.zip"
  fi
  GRADLE="$CACHED"
fi
say "Gradle: $GRADLE"

# --------------------------------------------------------------------- build
say "Building… the first run downloads the Android Gradle Plugin and takes a few minutes."
"$GRADLE" --no-daemon assembleDebug || die "The build failed. The Gradle output above says why.
  A missing SDK component is the usual cause — open this folder in Android Studio once
  and it will offer to install whatever is needed."

OUT=$(find app/build/outputs/apk/debug -name '*.apk' ! -name 'OUTDATED*' -newer local.properties 2>/dev/null | head -1)
[ -n "$OUT" ] || OUT=$(find app/build/outputs/apk/debug -name 'app-debug.apk' 2>/dev/null | head -1)
[ -n "$OUT" ] || die "The build reported success but no APK was found."
cp "$OUT" app/build/outputs/apk/debug/TelecallBridge-debug.apk

printf '\n\033[32mBuilt:\033[0m %s/app/build/outputs/apk/debug/TelecallBridge-debug.apk\n' "$(pwd)"
printf '\nInstall it with:\n  adb install -r "%s/app/build/outputs/apk/debug/TelecallBridge-debug.apk"\n' "$(pwd)"
printf '\nThen re-pair the phone — call-log access is a new permission in this build.\n'
