# Telecall Bridge

This native Android companion connects one agent account to the phone's physical SIM. It is intentionally separate from the PWA because Android's phone-call permission and call-state APIs are native capabilities.

## Build and install

Open this `android` directory in Android Studio, let Gradle sync, connect an Android phone with USB debugging enabled, and run the `app` configuration. The phone must grant `CALL_PHONE` and `READ_PHONE_STATE` permissions.

For an APK from the command line, use the Gradle wrapper created by Android Studio:

```bash
./gradlew :app:assembleDebug
```

The debug APK will be under `app/build/outputs/apk/debug/`.

## Pairing flow

1. Start the Telecall API server from the repository root with `npm run server`.
2. Run the PWA and create an agent account.
3. On the admin Agents page, select `Pair device` for that agent and copy the six-digit code.
4. Open this Android app, enter the server URL and code, and tap `Pair this phone`.
5. Leave the bridge app installed and running. The PWA will show the device as connected.

Use HTTPS for production. Cleartext traffic is enabled in this development build so a phone can connect to a local HTTP server; remove `android:usesCleartextTraffic="true"` before production release.
