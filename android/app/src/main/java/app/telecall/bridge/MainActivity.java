package app.telecall.bridge;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;

public class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST = 1001;
    private static final String PREFS = "telecall_bridge";
    private static final String SERVER_URL = "server_url";
    private static final String DEVICE_TOKEN = "device_token";
    private static final String DEVICE_ID = "device_id";

    private SharedPreferences preferences;
    private EditText serverInput;
    private EditText codeInput;
    private TextView statusView;
    private boolean waitingForPermissions;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!preferences.contains(DEVICE_ID)) {
            preferences.edit().putString(DEVICE_ID, Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID)).apply();
        }
        buildScreen();
        if (!preferences.getString(DEVICE_TOKEN, "").isEmpty()) startBridgeService();
    }

    private void buildScreen() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 48, 48, 48);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("Telecall Bridge");
        title.setTextSize(28);
        title.setTextColor(0xff0f1427);
        title.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(title, margin(LinearLayout.LayoutParams.MATCH_PARENT, 70, 0, 0, 0, 20));

        TextView description = new TextView(this);
        description.setText("Connect this Android phone so agents can place calls through its physical SIM from the Telecall PWA.");
        description.setTextSize(16);
        description.setTextColor(0xff5d6a80);
        root.addView(description, margin(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 28));

        label(root, "Telecall server URL");
        serverInput = new EditText(this);
        serverInput.setSingleLine(true);
        serverInput.setHint("https://your-telecall-host");
        serverInput.setText(preferences.getString(SERVER_URL, ""));
        root.addView(serverInput, margin(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 18));

        label(root, "Pairing code");
        codeInput = new EditText(this);
        codeInput.setSingleLine(true);
        codeInput.setInputType(2);
        codeInput.setHint("6-digit code from the admin screen");
        root.addView(codeInput, margin(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 20));

        Button pairButton = new Button(this);
        pairButton.setText("Pair this phone");
        pairButton.setOnClickListener(view -> pair());
        root.addView(pairButton, margin(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 20));

        statusView = new TextView(this);
        statusView.setTextSize(15);
        statusView.setTextColor(0xff2f9084);
        root.addView(statusView, margin(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 12));
        updateStatus();

        TextView note = new TextView(this);
        note.setText("Keep this app installed and allow phone permissions. It runs a small background bridge that receives call requests and reports call status.");
        note.setTextSize(13);
        note.setTextColor(0xff8b95a5);
        root.addView(note, margin(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 20, 0, 0));

        setContentView(scroll);
    }

    private void label(LinearLayout root, String text) {
        TextView label = new TextView(this);
        label.setText(text);
        label.setTextSize(13);
        label.setTextColor(0xff37445a);
        root.addView(label, margin(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 6));
    }

    private LinearLayout.LayoutParams margin(int width, int height, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.setMargins(left, top, right, bottom);
        return params;
    }

    private void pair() {
        if (!hasCallPermissions()) {
            waitingForPermissions = true;
            if (android.os.Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE, Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST);
            else requestPermissions(new String[]{Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE}, PERMISSION_REQUEST);
            return;
        }
        performPair();
    }

    private boolean hasCallPermissions() {
        return checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == PERMISSION_REQUEST && waitingForPermissions) {
            waitingForPermissions = false;
            if (hasCallPermissions()) performPair();
            else setStatus("Phone permissions are required to place and track SIM calls.", true);
        }
    }

    private void performPair() {
        String baseUrl = serverInput.getText().toString().trim().replaceAll("/$", "");
        String code = codeInput.getText().toString().trim();
        if (baseUrl.isEmpty() || code.isEmpty()) {
            setStatus("Enter the server URL and pairing code.", true);
            return;
        }
        setStatus("Pairing this phone…", false);
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("code", code);
                body.put("deviceId", preferences.getString(DEVICE_ID, "android-device"));
                body.put("deviceName", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
                JSONObject result = postJson(baseUrl + "/api/pairing/complete", body);
                preferences.edit().putString(SERVER_URL, baseUrl).putString(DEVICE_TOKEN, result.getString("token")).apply();
                startBridgeService();
                runOnUiThread(() -> { setStatus("Phone paired. The bridge is running.", false); codeInput.setText(""); });
            } catch (Exception error) {
                runOnUiThread(() -> setStatus(error.getMessage() == null ? "Pairing failed." : error.getMessage(), true));
            }
        }).start();
    }

    private void startBridgeService() {
        Intent service = new Intent(this, BridgeService.class);
        if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(service);
        else startService(service);
    }

    private void updateStatus() {
        if (preferences.getString(DEVICE_TOKEN, "").isEmpty()) setStatus("Not paired", true);
        else setStatus("Paired. Waiting for call requests.", false);
    }

    private void setStatus(String value, boolean error) {
        if (statusView != null) {
            statusView.setText(value);
            statusView.setTextColor(error ? 0xffb05f50 : 0xff2f9084);
        }
    }

    private JSONObject postJson(String endpoint, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.getOutputStream().write(bytes);
        int code = connection.getResponseCode();
        Scanner scanner = new Scanner(code >= 400 ? connection.getErrorStream() : connection.getInputStream()).useDelimiter("\\A");
        String response = scanner.hasNext() ? scanner.next() : "{}";
        if (code >= 400) throw new Exception(new JSONObject(response).optString("error", "Pairing failed."));
        return new JSONObject(response);
    }
}
