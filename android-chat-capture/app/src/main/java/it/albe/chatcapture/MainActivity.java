package it.albe.chatcapture;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.*;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final String ACTIVATE_URL = "https://conversation-capture-production.up.railway.app/device/activate";
    private TextView status;
    private EditText code;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(36, 48, 36, 36);
        root.setBackgroundColor(Color.rgb(245,247,250));

        TextView title = new TextView(this);
        title.setText("ChatGPT → Obsidian");
        title.setTextSize(26);
        root.addView(title);

        TextView info = new TextView(this);
        info.setText("\nSalva in tempo reale le conversazioni dell'app ChatGPT nel tuo Second Brain.\n");
        info.setTextSize(16);
        root.addView(info);

        code = new EditText(this);
        code.setHint("Codice di attivazione");
        code.setInputType(InputType.TYPE_CLASS_NUMBER);
        root.addView(code, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button activate = new Button(this);
        activate.setText("Attiva questo telefono");
        activate.setOnClickListener(v -> activate());
        root.addView(activate);

        Button accessibility = new Button(this);
        accessibility.setText("Apri Accessibilità");
        accessibility.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        root.addView(accessibility);

        status = new TextView(this);
        status.setTextSize(15);
        status.setPadding(0,24,0,0);
        root.addView(status);

        setContentView(root);
        refresh();
    }

    private void refresh() {
        SharedPreferences p = getSharedPreferences("capture", MODE_PRIVATE);
        boolean active = !p.getString("token", "").isEmpty();
        status.setText(active
            ? "✓ Telefono attivato. Ora abilita “ChatGPT → Obsidian” nelle impostazioni di Accessibilità."
            : "Telefono non ancora attivato.");
    }

    private void activate() {
        final String c = code.getText().toString().trim();
        if (c.isEmpty()) { status.setText("Inserisci il codice di attivazione."); return; }
        status.setText("Attivazione…");
        new Thread(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection)new URL(ACTIVATE_URL).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type","application/json");
                byte[] body = new JSONObject().put("code", c).toString().getBytes(StandardCharsets.UTF_8);
                try(OutputStream os=conn.getOutputStream()){os.write(body);}
                int sc=conn.getResponseCode();
                InputStream is = sc>=200&&sc<300 ? conn.getInputStream() : conn.getErrorStream();
                String text = readAll(is);
                if(sc<200||sc>=300) throw new IOException("Codice non valido");
                JSONObject j = new JSONObject(text);
                getSharedPreferences("capture",MODE_PRIVATE).edit()
                    .putString("token",j.getString("token"))
                    .putString("endpoint",j.getString("endpoint"))
                    .apply();
                runOnUiThread(() -> { code.setText(""); refresh(); });
            } catch(Exception e) {
                runOnUiThread(() -> status.setText("Attivazione non riuscita: "+e.getMessage()));
            }
        }).start();
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while((n=is.read(buf))>0) out.write(buf,0,n);
        return out.toString("UTF-8");
    }
}
