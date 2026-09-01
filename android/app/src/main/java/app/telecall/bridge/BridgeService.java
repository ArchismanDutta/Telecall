package app.telecall.bridge;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.CallLog;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;
import android.telecom.TelecomManager;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Keeps the phone in step with the server: collects call commands, dials them through the SIM,
 * and reports what the radio is actually doing.
 *
 * Call state is tracked three ways, deliberately. The registered listener gives an immediate
 * transition; the once-a-second poll reads the radio directly, so a listener the OS never
 * delivers (common from Android 12 onwards) cannot leave a call stuck on "Calling"; and the
 * call log supplies the true connected duration once the call ends, which is the only reliable
 * way to tell an answered call from one that rang out.
 */
public class BridgeService extends Service {
    private static final String PREFS = "telecall_bridge";
    private static final String CHANNEL = "telecall_bridge_channel";
    private static final String TOKEN = "device_token";
    private static final String SERVER = "server_url";
    private static final String ACTIVE_CALL = "active_call_id";
    private static final String ACTIVE_NUMBER = "active_number";
    private static final String OFFHOOK_AT = "active_offhook_at";
    private static final String DIALLED_AT = "active_dialled_at";

    /** How long the radio may stay idle after dialling before the call is written off. */
    private static final long DIAL_GRACE_MS = 25_000L;

    private ScheduledExecutorService executor;
    private TelephonyManager telephony;
    private Object callStateListener;
    private volatile int lastState = TelephonyManager.CALL_STATE_IDLE;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(42, notification());
        telephony = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
        executor = Executors.newSingleThreadScheduledExecutor();
        registerCallStateListener();
        lastState = readCallState();
        executor.scheduleWithFixedDelay(this::poll, 0, 1, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    /* ------------------------------------------------------------------ call state */

    private boolean canReadPhoneState() {
        return checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    private int readCallState() {
        if (telephony == null || !canReadPhoneState()) return TelephonyManager.CALL_STATE_IDLE;
        try {
            return Build.VERSION.SDK_INT >= 31 ? telephony.getCallStateForSubscription() : telephony.getCallState();
        } catch (Exception error) {
            return TelephonyManager.CALL_STATE_IDLE;
        }
    }

    private static String stateName(int state) {
        if (state == TelephonyManager.CALL_STATE_OFFHOOK) return "OFFHOOK";
        if (state == TelephonyManager.CALL_STATE_RINGING) return "RINGING";
        return "IDLE";
    }

    private void registerCallStateListener() {
        if (telephony == null || !canReadPhoneState()) return;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                BridgeTelephonyCallback callback = new BridgeTelephonyCallback(this);
                telephony.registerTelephonyCallback(executor, callback);
                callStateListener = callback;
            } else {
                new Handler(Looper.getMainLooper()).post(() -> {
                    PhoneStateListener listener = new PhoneStateListener() {
                        @Override
                        public void onCallStateChanged(int state, String number) {
                            onStateChanged(state);
                        }
                    };
                    telephony.listen(listener, PhoneStateListener.LISTEN_CALL_STATE);
                    callStateListener = listener;
                });
            }
        } catch (Exception ignored) {
            // The once-a-second poll covers us when the listener cannot be registered.
        }
    }

    /** API 31+ replacement for the phone-state broadcast, which is no longer delivered. */
    private static class BridgeTelephonyCallback extends TelephonyCallback implements TelephonyCallback.CallStateListener {
        private final BridgeService service;

        BridgeTelephonyCallback(BridgeService service) { this.service = service; }

        @Override
        public void onCallStateChanged(int state) { service.onStateChanged(state); }
    }

    private synchronized void onStateChanged(int state) {
        int previous = lastState;
        lastState = state;
        if (state == previous) return;
        String callId = pref(ACTIVE_CALL);
        if (callId.isEmpty()) return;

        if (state == TelephonyManager.CALL_STATE_OFFHOOK) {
            edit().putLong(OFFHOOK_AT, System.currentTimeMillis()).apply();
            postStatus(callId, "In progress", 0);
            return;
        }

        if (state == TelephonyManager.CALL_STATE_IDLE) {
            long offhookAt = getSharedPreferences(PREFS, MODE_PRIVATE).getLong(OFFHOOK_AT, 0L);
            if (offhookAt == 0L) {
                // The radio never went off-hook, so nothing was ever dialled.
                postStatus(callId, "Failed", 0);
                clearActiveCall();
                return;
            }
            // The call log is written a moment after the call ends.
            executor.schedule(() -> finishCall(callId, offhookAt), 1400, TimeUnit.MILLISECONDS);
        }
    }

    /**
     * Decides the outcome from the call log, which records the connected duration only --
     * zero means the other end never picked up. Falls back to wall-clock timing when the
     * call-log permission was declined.
     */
    private void finishCall(String callId, long offhookAt) {
        String number = pref(ACTIVE_NUMBER);
        long elapsed = Math.max(0, (System.currentTimeMillis() - offhookAt) / 1000);
        Integer logged = callLogDuration(number);
        if (logged == null) {
            postStatus(callId, "Answered", (int) elapsed);
        } else if (logged > 0) {
            postStatus(callId, "Answered", logged);
        } else {
            postStatus(callId, "Missed", 0);
        }
        clearActiveCall();
    }

    /** Connected seconds for the most recent outgoing call to this number, or null if unknown. */
    private Integer callLogDuration(String number) {
        if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return null;
        String tail = number.replaceAll("[^0-9]", "");
        if (tail.length() > 7) tail = tail.substring(tail.length() - 7);
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(
                    CallLog.Calls.CONTENT_URI,
                    new String[]{CallLog.Calls.NUMBER, CallLog.Calls.DURATION, CallLog.Calls.DATE},
                    CallLog.Calls.TYPE + " = ?",
                    new String[]{String.valueOf(CallLog.Calls.OUTGOING_TYPE)},
                    CallLog.Calls.DATE + " DESC LIMIT 5");
            if (cursor == null) return null;
            while (cursor.moveToNext()) {
                String logged = cursor.getString(0) == null ? "" : cursor.getString(0).replaceAll("[^0-9]", "");
                long when = cursor.getLong(2);
                if (System.currentTimeMillis() - when > 5 * 60_000L) continue;
                if (tail.isEmpty() || logged.endsWith(tail)) return (int) cursor.getLong(1);
            }
            return null;
        } catch (Exception error) {
            return null;
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    /* ---------------------------------------------------------------------- polling */

    private void poll() {
        String baseUrl = pref(SERVER);
        String token = pref(TOKEN);
        if (baseUrl.isEmpty() || token.isEmpty()) return;

        int state = readCallState();
        if (state != lastState) onStateChanged(state);
        expireUndialledCall();

        try {
            JSONObject result = getJson(baseUrl + "/api/devices/commands?token=" + token + "&callState=" + stateName(state));
            JSONObject command = result.optJSONObject("command");
            if (command == null) return;
            if ("PLACE_CALL".equals(command.optString("type"))) placeCall(command);
            if ("END_CALL".equals(command.optString("type"))) endCall(command);
        } catch (Exception ignored) {
            // The next poll retries while the device is offline.
        }
    }

    /** A call that was dialled but never reached the radio should not stay active forever. */
    private void expireUndialledCall() {
        String callId = pref(ACTIVE_CALL);
        if (callId.isEmpty()) return;
        if (getSharedPreferences(PREFS, MODE_PRIVATE).getLong(OFFHOOK_AT, 0L) != 0L) return;
        long dialledAt = getSharedPreferences(PREFS, MODE_PRIVATE).getLong(DIALLED_AT, 0L);
        if (dialledAt == 0L || System.currentTimeMillis() - dialledAt < DIAL_GRACE_MS) return;
        postStatus(callId, "Failed", 0);
        clearActiveCall();
    }

    /* ----------------------------------------------------------------------- calling */

    private void placeCall(JSONObject command) {
        if (!pref(ACTIVE_CALL).isEmpty()) return;
        String callId = command.optString("callId");
        String number = command.optString("number").replaceAll("[^0-9+]", "");
        edit().putString(ACTIVE_CALL, callId)
                .putString(ACTIVE_NUMBER, number)
                .putLong(DIALLED_AT, System.currentTimeMillis())
                .putLong(OFFHOOK_AT, 0L)
                .apply();
        postStatus(callId, "Calling", 0);
        try {
            if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                throw new SecurityException("CALL_PHONE permission is not granted");
            }
            TelecomManager telecom = (TelecomManager) getSystemService(TELECOM_SERVICE);
            if (telecom == null) throw new IllegalStateException("Phone calling service is unavailable");
            telecom.placeCall(Uri.fromParts("tel", number, null), new android.os.Bundle());
        } catch (Exception error) {
            postStatus(callId, "Failed", 0);
            clearActiveCall();
        }
    }

    private void endCall(JSONObject command) {
        String callId = command.optString("callId");
        if (!callId.equals(pref(ACTIVE_CALL))) {
            postStatus(callId, "Failed", 0);
            return;
        }
        try {
            if (Build.VERSION.SDK_INT < 28
                    || checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) != PackageManager.PERMISSION_GRANTED) {
                throw new SecurityException("ANSWER_PHONE_CALLS permission is not granted");
            }
            TelecomManager telecom = (TelecomManager) getSystemService(TELECOM_SERVICE);
            if (telecom == null || !telecom.endCall()) throw new IllegalStateException("The call could not be ended");
            // The idle transition reports the outcome; nothing else to do here.
        } catch (Exception error) {
            postStatus(callId, "Failed", 0);
            clearActiveCall();
        }
    }

    /* ------------------------------------------------------------------------- plumbing */

    private String pref(String key) {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(key, "");
    }

    private android.content.SharedPreferences.Editor edit() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).edit();
    }

    private void clearActiveCall() {
        edit().remove(ACTIVE_CALL).remove(ACTIVE_NUMBER).remove(OFFHOOK_AT).remove(DIALLED_AT).apply();
    }

    private void postStatus(String callId, String status, int seconds) {
        String baseUrl = pref(SERVER);
        String token = pref(TOKEN);
        if (baseUrl.isEmpty() || token.isEmpty() || callId.isEmpty()) return;
        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("token", token);
                body.put("status", status);
                body.put("seconds", seconds);
                postJson(baseUrl + "/api/calls/" + callId + "/status", body);
            } catch (Exception ignored) {
                // The server reconciles from the reported call state if this never lands.
            }
        });
    }

    private JSONObject getJson(String endpoint) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        int code = connection.getResponseCode();
        Scanner scanner = new Scanner(code >= 400 ? connection.getErrorStream() : connection.getInputStream()).useDelimiter("\\A");
        String response = scanner.hasNext() ? scanner.next() : "{}";
        if (code >= 400) throw new Exception("Bridge request failed");
        return new JSONObject(response);
    }

    private JSONObject postJson(String endpoint, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
        int code = connection.getResponseCode();
        Scanner scanner = new Scanner(code >= 400 ? connection.getErrorStream() : connection.getInputStream()).useDelimiter("\\A");
        String response = scanner.hasNext() ? scanner.next() : "{}";
        if (code >= 400) throw new Exception(response);
        return new JSONObject(response);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Telecall call bridge", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setContentTitle("Telecall Bridge")
                .setContentText("Connected and ready for SIM call requests")
                .setSmallIcon(android.R.drawable.sym_action_call)
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        try {
            if (callStateListener != null && telephony != null) {
                if (Build.VERSION.SDK_INT >= 31) telephony.unregisterTelephonyCallback((TelephonyCallback) callStateListener);
                else telephony.listen((PhoneStateListener) callStateListener, PhoneStateListener.LISTEN_NONE);
            }
        } catch (Exception ignored) {
        }
        if (executor != null) executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
