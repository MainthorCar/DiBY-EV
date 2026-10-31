package ar.diby.ev;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DiBY EV: muestra la página del cargador en pantalla completa.
 * - La página se actualiza sola (vive en GitHub Pages).
 * - Cada teléfono tiene una "llave fija" propia (deviceId) para iniciar cargas.
 * - Avisa cuando hay una versión nueva de la app en GitHub.
 */
public class MainActivity extends Activity {

    private WebView web;

    private static final String OFFLINE =
        "<html><body style='margin:0;background:#000;color:#F2FFF8;font-family:sans-serif;"
        + "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px'>"
        + "<b style='font-size:26px'>DiBY <span style='color:#2BFF88'>EV</span></b>"
        + "<span style='color:#8FA39A'>Sin conexión a internet</span>"
        + "<button onclick=\"location.href='" + BuildConfig.SITE + "?app=1'\" "
        + "style='height:48px;padding:0 28px;border:0;border-radius:12px;background:#2BFF88;color:#001A0B;"
        + "font-weight:700;font-size:15px'>REINTENTAR</button></body></html>";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE); // siempre la última versión de la página
        s.setUserAgentString(s.getUserAgentString() + " DiBYApp/" + BuildConfig.VERSION_CODE);

        web.addJavascriptInterface(new Puente(), "DiBYApp");
        web.setWebChromeClient(new WebChromeClient()); // carteles y preguntas de la página
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (u.getHost() != null && u.getHost().endsWith("github.io")) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadDataWithBaseURL(BuildConfig.SITE, OFFLINE, "text/html", "utf-8", null);
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(BuildConfig.SITE + "?app=" + BuildConfig.VERSION_CODE);

        buscarActualizacion();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        // Primero se cierra lo que esté abierto en la página (ventanas, ajustes, pestañas)
        web.evaluateJavascript("(window.diBYBack && window.diBYBack()) ? 'si' : 'no'", v -> {
            if (v != null && v.contains("si")) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    /** Lo que la página puede pedirle al teléfono. */
    class Puente {
        @JavascriptInterface
        public String deviceId() {
            SharedPreferences p = getSharedPreferences("diby", MODE_PRIVATE);
            String id = p.getString("id", null);
            if (id == null) {
                id = UUID.randomUUID().toString().replace("-", "").substring(0, 16).toUpperCase();
                p.edit().putString("id", id).apply();
            }
            return id;
        }

        @JavascriptInterface
        public String deviceName() {
            String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
            return (m.isEmpty() ? "" : m.substring(0, 1).toUpperCase() + m.substring(1) + " ") + Build.MODEL;
        }

        @JavascriptInterface
        public int version() {
            return BuildConfig.VERSION_CODE;
        }
    }

    /** Mira en GitHub si hay una app más nueva y ofrece descargarla. */
    private void buscarActualizacion() {
        new Thread(() -> {
            try {
                URL url = new URL("https://api.github.com/repos/" + BuildConfig.REPO + "/releases/latest");
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                if (c.getResponseCode() != 200) return;
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                }
                Matcher m = Pattern.compile("\"tag_name\"\\s*:\\s*\"app-v(\\d+)\"").matcher(sb);
                if (!m.find()) return;
                int ultima = Integer.parseInt(m.group(1));
                if (ultima <= BuildConfig.VERSION_CODE) return;
                runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Hay una versión nueva de DiBY EV")
                    .setMessage("Tenés la 1." + BuildConfig.VERSION_CODE + " y está disponible la 1." + ultima + ". Se descarga e instalás encima: no se pierde nada.")
                    .setPositiveButton("Actualizar", (d, w) -> startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://github.com/" + BuildConfig.REPO + "/releases/latest/download/DiBY-EV.apk"))))
                    .setNegativeButton("Después", null)
                    .show());
            } catch (Exception ignored) {
                // sin internet o GitHub no responde: se intenta la próxima vez
            }
        }).start();
    }
}
