# Telecall Bridge

The Android companion that owns the SIM. It receives call commands from the Telecall server,
dials them, and reports what the radio is actually doing.

## Building

Needs a JDK 17+ and the Android SDK. Android Studio provides both.

```bash
./build-apk.sh
```

Or open this folder in Android Studio and choose **Build → Build APK(s)**.

The result is `app/build/outputs/apk/debug/TelecallBridge-debug.apk`.

## Installing

```bash
adb install -r app/build/outputs/apk/debug/TelecallBridge-debug.apk
```

Then open Telecall Bridge, enter the server URL and the six-digit pairing code from the
admin's Agents page, and tap **Pair this phone**.

## Permissions

All five are requested when you tap **Pair this phone**. Grant every one:

| Permission | Why |
| --- | --- |
| `CALL_PHONE` | Places the call through the SIM. |
| `READ_PHONE_STATE` | Reports whether the line is idle or in use. |
| `READ_CALL_LOG` | Reads the connected duration, which is the only reliable way to tell an answered call from one that rang out. Without it, talk time is estimated from when dialling began. |
| `ANSWER_PHONE_CALLS` | Hangs up when the agent presses End call. |
| `POST_NOTIFICATIONS` | Shows the ongoing bridge notification (Android 13+). |

If you are upgrading from an earlier build, Android will ask for call-log access the next time
you pair, because that permission is new.

## How call state is tracked

Three mechanisms, deliberately overlapping, because no single one is reliable across Android
versions:

1. **A registered listener** — `TelephonyCallback` on Android 12+, `PhoneStateListener` below
   it. Gives an immediate transition when it fires.
2. **A once-a-second read of the radio state**, sent to the server with every command poll.
   This is what stops a call sticking on "Calling" when the listener never fires — which is
   exactly what happens on Android 12+, where the old `PHONE_STATE` broadcast this app used to
   rely on is no longer delivered to ordinary apps.
3. **The call log**, read a moment after the call ends. Its duration counts connected seconds
   only, so zero means the other end never picked up. This is what separates **Answered** from
   **Missed**, and it gives the true talk time rather than including the ringing.

The server draws its own conclusion from (2) if the phone's own report never arrives, so a
crashed or offline handset cannot leave a call open forever.

## Known gaps

- **Rejected** is reported as **Missed**: from the call log both look identical (zero
  duration). Telling them apart needs the app to become the device's default dialler.
- No SIM picker on dual-SIM handsets — the system default is used, or Android prompts.
- Polling once a second is heavy on battery; FCM push would replace it.
- There is no Gradle wrapper committed; `build-apk.sh` generates one if Gradle is installed.
