package it.albe.chatcapture;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class ApiClient {
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private ApiClient(){}

    public static void enqueue(Context ctx, JSONObject payload) {
        SharedPreferences p = ctx.getSharedPreferences("capture", Context.MODE_PRIVATE);
        Set<String> q = new HashSet<>(p.getStringSet("pending", Collections.emptySet()));
        q.add(payload.toString());
        p.edit().putStringSet("pending", q).apply();
        flush(ctx.getApplicationContext());
    }

    public static void ping(Context ctx, JSONObject payload) {
        SharedPreferences p = ctx.getSharedPreferences("capture", Context.MODE_PRIVATE);
        String endpoint = p.getString("endpoint","");
        String token = p.getString("token","");
        if(endpoint.isEmpty() || token.isEmpty()) return;
        final String pingEndpoint = endpoint.replace("/capture-turn","/device/ping");
        EXEC.execute(() -> {
            try {
                HttpURLConnection conn=(HttpURLConnection)new URL(pingEndpoint).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type","application/json");
                conn.setRequestProperty("Authorization","Bearer "+token);
                byte[] body=payload.toString().getBytes(StandardCharsets.UTF_8);
                try(OutputStream os=conn.getOutputStream()){os.write(body);}
                try{InputStream is=conn.getResponseCode()>=200&&conn.getResponseCode()<300?conn.getInputStream():conn.getErrorStream(); if(is!=null)is.close();}catch(Exception ignored){}
            } catch(Exception ignored){}
        });
    }

    public static void sendSnapshot(Context ctx, JSONObject payload) {
        SharedPreferences p = ctx.getSharedPreferences("capture", Context.MODE_PRIVATE);
        String endpoint = p.getString("endpoint","");
        String token = p.getString("token","");
        if(endpoint.isEmpty() || token.isEmpty()) return;
        final String snapshotEndpoint = endpoint.replace("/capture-turn","/capture-snapshot");
        EXEC.execute(() -> {
            try {
                HttpURLConnection conn=(HttpURLConnection)new URL(snapshotEndpoint).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(8000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type","application/json");
                conn.setRequestProperty("Authorization","Bearer "+token);
                byte[] body=payload.toString().getBytes(StandardCharsets.UTF_8);
                try(OutputStream os=conn.getOutputStream()){os.write(body);}
                try{InputStream is=conn.getResponseCode()>=200&&conn.getResponseCode()<300?conn.getInputStream():conn.getErrorStream(); if(is!=null)is.close();}catch(Exception ignored){}
            } catch(Exception ignored){}
        });
    }

    public static void flush(Context ctx) {
        EXEC.execute(() -> {
            SharedPreferences p = ctx.getSharedPreferences("capture", Context.MODE_PRIVATE);
            String endpoint = p.getString("endpoint","");
            String token = p.getString("token","");
            if(endpoint.isEmpty() || token.isEmpty()) return;

            Set<String> q = new HashSet<>(p.getStringSet("pending", Collections.emptySet()));
            if(q.isEmpty()) return;
            Set<String> left = new HashSet<>(q);
            for(String raw : q) {
                try {
                    HttpURLConnection conn=(HttpURLConnection)new URL(endpoint).openConnection();
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(15000);
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type","application/json");
                    conn.setRequestProperty("Authorization","Bearer "+token);
                    byte[] body=raw.getBytes(StandardCharsets.UTF_8);
                    try(OutputStream os=conn.getOutputStream()){os.write(body);}
                    int sc=conn.getResponseCode();
                    if(sc>=200&&sc<300) left.remove(raw);
                    try{InputStream is=sc>=200&&sc<300?conn.getInputStream():conn.getErrorStream(); if(is!=null)is.close();}catch(Exception ignored){}
                } catch(Exception ignored){}
            }
            p.edit().putStringSet("pending", left).apply();
        });
    }
}
