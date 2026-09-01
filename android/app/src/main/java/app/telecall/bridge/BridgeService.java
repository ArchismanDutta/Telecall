package app.telecall.bridge;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.telephony.TelephonyManager;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class BridgeService extends Service {
    private static final String PREFS = "telecall_bridge";
    private static final String CHANNEL = "telecall_bridge_channel";
    private static final String TOKEN = "device_token";
    private static final String SERVER = "server_url";
    private static final String ACTIVE_CALL = "active_call_id";
    private static final String STARTED_AT = "active_started_at";
    private static final String ANSWERED = "active_answered";

    private ScheduledExecutorService executor;
    private BroadcastReceiver callStateReceiver;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(42, notification());
        registerCallStateReceiver();
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::poll, 0, 3, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    private void poll() {
        String baseUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(SERVER, "");
        String token = getSharedPreferences(PREFS, MODE_PRIVATE).getString(TOKEN, "");
        if (baseUrl.isEmpty() || token.isEmpty()) return;
        try {
            JSONObject result = getJson(baseUrl + "/api/devices/commands?token=" + token);
            JSONObject command = result.optJSONObject("command");
            if (command != null && "PLACE_CALL".equals(command.optString("type"))) placeCall(command);
        } catch (Exception ignored) {
            // The next poll retries while the device is offline.
        }
    }

    private void placeCall(JSONObject command) {
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).getString(ACTIVE_CALL, "").isEmpty()) return;
        String callId = command.optString("callId");
        String number = command.optString("number").replaceAll("[^0-9+]", "");
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(ACTIVE_CALL, callId)
                .putLong(STARTED_AT, System.currentTimeMillis())
                .putBoolean(ANSWERED, false)
                .apply();
        postStatus(callId, "Calling", 0);
        try {
            if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) throw new SecurityException("CALL_PHONE permission is not granted");
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + number));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception error) {
            postStatus(callId, "Failed", 0);
            clearActiveCall();
        }
    }

    private void registerCallStateReceiver() {
        callStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
                String callId = getSharedPreferences(PREFS, MODE_PRIVATE).getString(ACTIVE_CALL, "");
                if (callId.isEmpty()) return;
                String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
                if (TelephonyManager.EXTRA_STATE_OFFHOOK.equals(state)) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(ANSWERED, true).apply();
                    postStatus(callId, "In progress", 0);
                } else if (TelephonyManager.EXTRA_STATE_IDLE.equals(state)) {
                    boolean answered = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(ANSWERED, false);
                    long started = getSharedPreferences(PREFS, MODE_PRIVATE).getLong(STARTED_AT, System.currentTimeMillis());
                    int seconds = answered ? (int) Math.max(0, (System.currentTimeMillis() - started) / 1000) : 0;
                    postStatus(callId, answered ? "Answered" : "Missed", seconds);
                    clearActiveCall();
                }
            }
        };
        registerReceiver(callStateReceiver, new IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED));
    }

    private void postStatus(String callId, String status, int seconds) {
        String baseUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(SERVER, "");
        if (baseUrl.isEmpty()) return;
        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("status", status);
                body.put("seconds", seconds);
                postJson(baseUrl + "/api/calls/" + callId + "/status", body);
            } catch (Exception ignored) {
            }
        });
    }

    private void clearActiveCall() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(ACTIVE_CALL).remove(STARTED_AT).remove(ANSWERED).apply();
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
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setContentTitle("Telecall Bridge")
                .setContentText("Connected and ready for SIM call requests")
                .setSmallIcon(android.R.drawable.sym_action_call)
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        if (callStateReceiver != null) unregisterReceiver(callStateReceiver);
        if (executor != null) executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
