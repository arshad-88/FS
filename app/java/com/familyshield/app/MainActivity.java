package com.familyshield.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.util.List;
import java.util.Locale;

/**
 * FamilyShield host activity.
 *
 * <p>Single WebView that loads {@code file:///android_asset/www/index.html}. The page is a local
 * asset and all navigations away from it are refused, so the bundled web layer can never be
 * navigated to a remote document. The only way out of the app is the explicit {@code openUrl} /
 * {@code dial} / {@code shareText} bridge calls made by {@code app.js} in response to a user tap.
 *
 * <p>REVISED in 1.1: the shell is no longer permission-free or fully offline. It declares
 * INTERNET plus COARSE/FINE location, and network access is narrowed to the single self-hosted
 * backend origin the user configures in Settings — an allowlist in {@code shouldInterceptRequest},
 * backed by {@code network_security_config.xml} (no cleartext, system CAs only) and by
 * {@code usesCleartextTraffic="false"}. Sub-resources are refused until an origin exists, so a
 * fresh install still behaves like the old offline build.
 *
 * <p>Native bridge exposed to the web layer as {@code window.FSAndroid} (see docs/CONTRACTS.md §4):
 * <ul>
 *   <li>{@code shareText(title, text)} — ACTION_SEND chooser ("share this SMS with a family member")</li>
 *   <li>{@code copyText(text)} — copy the report to the clipboard</li>
 *   <li>{@code openUrl(url)} — open http/https only, via the system browser</li>
 *   <li>{@code dial(number)} — ACTION_DIAL, digits and + * # only (never ACTION_CALL)</li>
 *   <li>{@code consumeSharedText()} — one-shot read of the text shared into the app</li>
 *   <li>{@code platformInfo()} — small JSON blob describing the host</li>
 *   <li>{@code log(text)} — logcat line, truncated</li>
 *   <li>{@code storeGet(key)} / {@code storeSet(key, json)} — SharedPreferences persistence, used
 *       because file:// WebView localStorage is unreliable</li>
 *   <li>{@code setBackendOrigin(origin)} / {@code getBackendOrigin()} — the one backend origin the
 *       WebView is allowed to load, or {@code ""} when unset. See {@link #setBackendOrigin(String)}.</li>
 *   <li>{@code requestLocation(id, fine)} / {@code cancelLocation(id)} — one-shot fix, delivered to
 *       {@code window.FS.nativeLocation(json)}. See {@link #requestLocation(String, boolean)}.</li>
 * </ul>
 *
 * <p>The bridge lives on the JavaBridge thread, so anything that touches UI (chooser, dialer,
 * browser) is posted to the main thread first. Java and JS are deliberately decoupled: every method
 * is null-safe and swallows failures, because a crash here would look like a scam warning.
 */
public final class MainActivity extends Activity {

    private static final String TAG = "FamilyShield";

    /** Bundled web layer; loaded as a local asset, never over the network. */
    private static final String WEB_APP_URL = "file:///android_asset/www/index.html";
    /** Name the web layer looks for: {@code window.FSAndroid}. */
    private static final String JS_BRIDGE = "FSAndroid";
    /** SharedPreferences file holding history + family list JSON. */
    private static final String PREFS_NAME = "fs_store";
    /** Instance-state key for a share that arrived before the WebView finished loading. */
    private static final String STATE_SHARED_TEXT = "fs.pendingSharedText";
    /** Mirrors android:versionName in AndroidManifest.xml. */
    private static final String APP_VERSION = "1.0";

    /** Engine input cap (docs/CONTRACTS.md §2) — shared text is clipped to the same size. */
    private static final int MAX_SHARED_CHARS = 20000;
    private static final int MAX_STORE_CHARS = 512 * 1024;
    private static final int MAX_LOG_CHARS = 3500;
    /** Upper bound for clipboard text handed to the scam analyser from the Paste button. */
    private static final int MAX_PASTED_CHARS = 8000;
    private static final int MAX_KEY_CHARS = 120;

    /** Settings key holding the configured backend origin ("" = not configured). */
    private static final String PREFS_BACKEND_ORIGIN = "fs_backend_origin";
    /** Hosts that may use plain http, because they can only ever mean "this device". */
    private static final String[] LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "10.0.2.2", "10.0.3.2"};
    private static final int FILE_CHOOSER_REQUEST = 0x4f11;
    private static final int REQ_LOCATION = 0x4f12;
    private static final int REQ_NOTIFICATIONS = 0x4f13;

    /** Channel for server-confirmed emergency / helper updates (API 26+). */
    private static final String CHANNEL_ALERTS = "familyshield_alerts";
    private static final int NOTIFICATION_BASE_ID = 0x4600;
    private static final int MAX_NOTIFICATION_TITLE = 120;
    private static final int MAX_NOTIFICATION_BODY = 500;
    /** Rotates the notification id so consecutive updates stack instead of overwriting. */
    private int notificationSequence;
    /** True once the POST_NOTIFICATIONS prompt was shown in this process. */
    private boolean notificationPermissionAsked;

    // ------------------------------------------------------------ cloud messaging

    /** True between onResume() and onPause(); decides in-app refresh vs. tray notification. */
    private static volatile boolean appForeground;
    /** Live activity, so FCM callbacks (which run on a service thread) can reach the WebView. */
    private static java.lang.ref.WeakReference<MainActivity> currentActivity =
            new java.lang.ref.WeakReference<>(null);
    /** Token that arrived before the page was ready; flushed from onPageFinished(). */
    private static String pendingPushToken;
    /** Notification tap that arrived before the page was ready; flushed from onPageFinished(). */
    private String pendingPushTarget;
    /** Upper bound for a single location fix before we report failure to the page. */
    private static final long LOCATION_TIMEOUT_MS = 20000L;

    private final Object sharedLock = new Object();
    private WebView webView;
    private String pendingSharedText;
    /**
     * True between {@code onPageFinished} and the next reload/teardown of the asset page.
     *
     * {@link #onBackPressed()} must not delegate to {@code evaluateJavascript()} while the page is
     * still loading: the {@link BackCallback} never fires, so nothing calls finish() and the back
     * press is silently swallowed (the app just looks frozen). Before the first onPageFinished the
     * web layer has no back stack by definition, so falling through to a normal finish is correct.
     */
    private volatile boolean pageReady;

    /** Main-thread handler used for the location timeout and for bridge → UI hops. */
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** Page-supplied id of the in-flight location request, or null when none is running. */
    private String pendingLocationId;
    private boolean pendingLocationFine;
    private LocationListener pendingLocationListener;
    /** One location request at a time; a second call supersedes the first with an error. */
    private final Runnable locationTimeout = new Runnable() {
        @Override
        public void run() {
            finishLocation(null, "timeout");
        }
    };
    /**
     * ValueCallback handed to us by WebChromeClient.onShowFileChooser, or null. It survives rotation
     * because the activity declares configChanges for orientation/screenSize/density, so the picker
     * result always comes back to the same instance.
     */
    private ValueCallback<Uri[]> pendingFileCallback;

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Manifest also sets this; re-applying keeps the WebView resizing when the soft keyboard
        // opens (the textarea sits above the tabbar and must stay visible).
        if (getWindow() != null) {
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }

        restoreSharedText(savedInstanceState);

        webView = findViewById(R.id.web_view);
        if (webView == null) {
            Log.e(TAG, "activity_main.xml is missing @id/web_view");
            finish();
            return;
        }

        configureWebView(webView);
        // Attach the bridge before loading, and only ever with our own asset page.
        webView.addJavascriptInterface(new Bridge(), JS_BRIDGE);

        // Read the launch intent (SEND / VIEW text/plain) before loading so that app.js can pick the
        // text up from consumeSharedText() during init.
        readIntentText(getIntent());
        // A tap that started the process still has to route once the page is live.
        pendingPushTarget = FsPush.targetFromIntent(getIntent());
        webView.loadUrl(WEB_APP_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // launchMode=singleTask: a notification tap while the activity is alive lands here. Route it
        // in place; only a new share needs the document reload below.
        String pushTarget = FsPush.targetFromIntent(intent);
        if (pushTarget != null && !pushTarget.isEmpty()) {
            deliverPushTarget(pushTarget);
        }
        // launchMode=singleTask: a second share arrives here instead of in onCreate. Reloading the
        // page lets app.js consume the new text through its normal init path.
        if (readIntentText(intent) && webView != null) {
            // The reload starts a brand new document, so the JS back hook is gone until the next
            // onPageFinished: treat back presses during that window as "nothing loaded yet".
            pageReady = false;
            webView.loadUrl(WEB_APP_URL);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        appForeground = true;
        currentActivity = new java.lang.ref.WeakReference<>(this);
        if (webView != null) {
            webView.onResume();
        }
        // Ask Firebase for the current token now; it is cached, so this is cheap after the first call.
        FsPush.requestToken(this);
    }

    @Override
    protected void onPause() {
        // From here on a message must become a tray notification, not a JS call into a paused page.
        appForeground = false;
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        synchronized (sharedLock) {
            if (pendingSharedText != null) {
                outState.putString(STATE_SHARED_TEXT, pendingSharedText);
            }
        }
    }

    @Override
    protected void onDestroy() {
        // Drop the GPS listener and any half-finished picker before the WebView goes away, otherwise
        // a fix could arrive after the page it belongs to has been destroyed.
        finishLocation(null, "destroyed");
        mainHandler.removeCallbacks(locationTimeout);
        failFileChooser();
        releaseWebView();
        super.onDestroy();
    }

    /**
     * Let the web layer handle its own back stack (open sheet, inner view). Falls through to a normal
     * finish when the page is not loaded yet or when app.js reports it has nothing to go back to.
     */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        final WebView view = webView;
        if (view == null || !pageReady) {
            // No WebView at all, or the asset page has not finished loading yet: window.FS.app.back
            // does not exist, evaluateJavascript() would never call BackCallback, and the press
            // would be swallowed. Nothing can be "open" in the web layer at this point.
            super.onBackPressed();
            return;
        }
        String script = "(function(){try{return !!(window.FS && window.FS.app &&"
                + " typeof window.FS.app.back === 'function' && window.FS.app.back());}"
                + "catch(e){return false;}})()";
        try {
            view.evaluateJavascript(script, new BackCallback(this));
        } catch (RuntimeException e) {
            finish();
        }
    }

    // ---------------------------------------------------------------- WebView setup

    @SuppressWarnings("deprecation")
    private void configureWebView(WebView view) {
        view.setBackgroundColor(getColor(R.color.fs_bg));
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(false);
        }

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        // Clipboard reads go through the native bridge ({@link #readClipboard()}), not the async
        // Clipboard API: WebView only grants that API with the hidden setJavaScriptCanAccessClipboard
        // switch (unavailable in the public SDK, so it cannot be compiled against android.jar), and
        // it silently rejects reads on a file:// origin. The bridge path works on every API level.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(true);              // only ever used for /android_asset
        // Needed by the system photo picker: the picked file arrives as a content:// URI with a
        // one-shot grant. Every read still goes through the owning provider's own permission check
        // and the shell holds no media permission, so this grants no standing gallery access.
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);  // css/, js/, fonts/ next to index.html
        settings.setAllowUniversalAccessFromFileURLs(false);
        // The page is a file:// document, so its origin is opaque ("null") to the CORS machinery.
        // A self-hosted backend must therefore answer with Access-Control-Allow-Origin: * (or echo
        // the literal "null"); docs/CONTRACTS.md §4 records that as part of the backend contract.
        settings.setGeolocationEnabled(false);          // location goes through the bridge instead
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setDefaultTextEncodingName("utf-8");
        try {
            // Network loads must stay *enabled* now that the page may talk to its self-hosted
            // backend; the gate moved from "the WebView has no network" to ShieldClient's
            // origin allowlist, which refuses every http/https request that is not the one backend
            // origin the user configured. Off by default therefore still means off.
            settings.setBlockNetworkLoads(false);
        } catch (SecurityException e) {
            // Thrown when the INTERNET permission is missing; then the WebView simply has no network.
            Log.w(TAG, "setBlockNetworkLoads refused", e);
        }

        view.setWebViewClient(new ShieldClient());
        view.setWebChromeClient(new ShieldChromeClient());
    }

    private void releaseWebView() {
        WebView view = webView;
        webView = null;
        pageReady = false;
        if (view == null) {
            return;
        }
        try {
            view.removeJavascriptInterface(JS_BRIDGE);
            view.setWebViewClient(new WebViewClient());
            ViewGroup parent = view.getParent() instanceof ViewGroup ? (ViewGroup) view.getParent() : null;
            if (parent != null) {
                parent.removeView(view);
            }
            view.destroy();
        } catch (RuntimeException e) {
            Log.w(TAG, "WebView teardown failed", e);
        }
    }

    /** No navigations away from the asset page, and no network except the configured backend origin. */
    @SuppressWarnings("deprecation")
    // NOTE: package-private, not private. A private nested class makes javac emit a synthetic
    // constructor with an unnamed parameter, and d8 34.0.0 (R8 8.2) crashes with a
    // NullPointerException on that MethodParameters entry. Same applies to Bridge/BackCallback.
    final class ShieldClient extends WebViewClient {

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The renderer died (OOM or crash). Rebuilding beats leaving a blank window.
            if (view != null) {
                ViewGroup parent = view.getParent() instanceof ViewGroup ? (ViewGroup) view.getParent() : null;
                if (parent != null) {
                    parent.removeView(view);
                }
                view.destroy();
            }
            webView = null;
            if (!isFinishing()) {
                recreate();
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            // window.FS (and therefore FS.app.back) exists from here on, so back presses may be
            // delegated to the web layer. Fires for every document, including the reload that
            // onNewIntent() triggers for a second share.
            pageReady = true;
            flushPendingPush();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return true; // never navigate away from the bundled asset page
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return true;
        }

        /**
         * The single network gate. Runs on a background thread for every request the page makes,
         * before DNS resolution, so a refusal here means the packet is never sent.
         *
         * <ul>
         *   <li>Non-network schemes (file:, data:, blob:, about:) are left to the WebView, which
         *       already restricts them to the bundled assets.</li>
         *   <li>An http/https request to the configured backend origin — same scheme, host, port and
         *       path prefix — is allowed through, and only then is the real request made (the
         *       platform network security config still forbids cleartext to anything but loopback).</li>
         *   <li>Anything else gets an empty 200 body. Returning a WebResourceResponse instead of
         *       null is what makes this airtight: null would mean "go to the network".</li>
         * </ul>
         */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request == null ? null : request.getUrl();
            String scheme = uri == null ? null : uri.getScheme();
            if (!isNetworkScheme(scheme)) {
                return null;
            }
            if (isAllowedBackendUrl(uri)) {
                return null; // the one origin the user configured
            }
            return blockedResponse();
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            if (!startsWithNetworkScheme(url)) {
                return null;
            }
            Uri uri;
            try {
                uri = Uri.parse(url);
            } catch (RuntimeException e) {
                return blockedResponse();
            }
            return isAllowedBackendUrl(uri) ? null : blockedResponse();
        }

        /** Empty body, so a blocked fetch fails fast and silently instead of hanging. */
        private WebResourceResponse blockedResponse() {
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }
    }

    // ---------------------------------------------------------------- backend origin

    /**
     * Exact-match allowlist test. Deliberately strict, because this is the whole network policy:
     * scheme, host (case-insensitive), effective port and path prefix must all match the stored
     * origin. A prefix match also catches the obvious look-alikes
     * ({@code https://api.example.com.evil.test}), since the stored value always ends without a
     * trailing slash.
     */
    private boolean isAllowedBackendUrl(Uri uri) {
        if (uri == null) {
            return false;
        }
        String origin = backendOrigin();
        if (origin.isEmpty()) {
            return false;
        }
        Uri base;
        try {
            base = Uri.parse(origin);
        } catch (RuntimeException e) {
            return false;
        }
        if (base.getHost() == null || uri.getHost() == null) {
            return false;
        }
        if (!eq(base.getScheme(), uri.getScheme())) {
            return false;
        }
        if (!base.getHost().equalsIgnoreCase(uri.getHost())) {
            return false;
        }
        if (effectivePort(base) != effectivePort(uri)) {
            return false;
        }
        String basePath = base.getPath() == null ? "" : base.getPath();
        String path = uri.getPath() == null ? "/" : uri.getPath();
        if (basePath.isEmpty() || "/".equals(basePath)) {
            return true;
        }
        return path.equals(basePath) || path.startsWith(basePath + "/");
    }

    private static int effectivePort(Uri uri) {
        if (uri.getPort() != -1) {
            return uri.getPort();
        }
        return "http".equalsIgnoreCase(uri.getScheme()) ? 80 : 443;
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equalsIgnoreCase(b);
    }

    /** Configured backend origin, or "" when the user has not set one. */
    private String backendOrigin() {
        try {
            String stored = store().getString(PREFS_BACKEND_ORIGIN, null);
            return stored == null ? "" : stored;
        } catch (RuntimeException e) {
            Log.w(TAG, "backendOrigin read failed", e);
            return "";
        }
    }

    /**
     * Validates and stores the backend origin.
     *
     * <p>Accepted: {@code https://host[:port][/path]} with no query, fragment, userinfo or trailing
     * slash. Plain {@code http://} is accepted only for a loopback host (localhost, 127.0.0.1, or
     * the emulator's 10.0.2.2/10.0.3.2), which is the only case where the network security config
     * permits cleartext — so a user who types their backend host as http on a LAN IP is told why it
     * was rejected instead of silently getting an unencrypted connection. Returns "" on success or
     * a short, user-shown reason on failure; an empty argument clears the setting.
     */
    private String setBackendOrigin(String raw) {
        String value = trim(raw);
        if (value.isEmpty()) {
            try {
                store().edit().remove(PREFS_BACKEND_ORIGIN).apply();
            } catch (RuntimeException e) {
                Log.w(TAG, "backendOrigin clear failed", e);
                return "Could not save the backend address.";
            }
            return "";
        }
        if (value.length() > 300) {
            return "That address is too long.";
        }
        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (RuntimeException e) {
            return "That does not look like a web address.";
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            return "That address has no host name.";
        }
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            return "Use an https:// address.";
        }
        if (uri.getQuery() != null || uri.getFragment() != null || uri.getUserInfo() != null) {
            return "Remove the ?, # and any user:password part from the address.";
        }
        if ("http".equals(scheme) && !isLoopbackHost(host)) {
            return "Plain http is only allowed for localhost. Use https:// for any other server.";
        }
        String path = uri.getPath() == null ? "" : uri.getPath();
        while (path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        StringBuilder canonical = new StringBuilder(scheme).append("://").append(host.toLowerCase(Locale.US));
        if (uri.getPort() != -1) {
            canonical.append(':').append(uri.getPort());
        }
        canonical.append(path);
        String origin = canonical.toString();
        try {
            store().edit().putString(PREFS_BACKEND_ORIGIN, origin).apply();
        } catch (RuntimeException e) {
            Log.w(TAG, "backendOrigin write failed", e);
            return "Could not save the backend address.";
        }
        return "";
    }

    private static boolean isLoopbackHost(String host) {
        String h = host.toLowerCase(Locale.US);
        for (String allowed : LOOPBACK_HOSTS) {
            if (allowed.equals(h)) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- photo picker

    /**
     * Grants any capability request the page makes. Everything reaching this callback originates
     * from the bundled asset document, whose script we ship, and this app has no dangerous
     * permission but location — which the bridge requests explicitly, with its own runtime prompt.
     * Returning DENY for resources (mic/camera) keeps a compromised bundle from turning on hardware
     * the manifest never declared.
     */
    final class ShieldChromeClient extends WebChromeClient {

        @Override
        public void onPermissionRequest(android.webkit.PermissionRequest request) {
            String[] resources = request == null ? null : request.getResources();
            if (resources != null) {
                for (String resource : resources) {
                    if (android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                            || android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        request.deny();
                        return;
                    }
                }
            }
            if (request != null) {
                request.grant(request.getResources());
            }
        }

        /**
         * The activity used to have no chrome client, so {@code <input type="file">} silently did
         * nothing. Route it to the system picker: on API 33+ ACTION_PICK_IMAGES (no media permission,
         * per-file grant), on older releases ACTION_GET_CONTENT restricted to images and videos.
         */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (callback == null) {
                return false;
            }
            if (pendingFileCallback != null) {
                // A second tap while the picker is open: answer the abandoned request so the page is
                // not left waiting on it forever.
                pendingFileCallback.onReceiveValue(null);
            }
            pendingFileCallback = callback;
            return openFileChooser();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                                                       GeolocationPermissions.Callback callback) {
            // The page does not use navigator.geolocation (settings.setGeolocationEnabled(false) and
            // the manifest has no ACCESS_BACKGROUND_LOCATION); answer every prompt with a refusal
            // rather than leaving the WebView spinner hanging.
            if (callback != null) {
                callback.invoke(origin, false, false);
            }
        }
    }

    /**
     * Launches the system picker. Returns false only when no picker exists at all, in which case the
     * pending callback is failed so the page sees a cancelled pick instead of a dead button.
     */
    private boolean openFileChooser() {
        Intent intent = null;
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                intent = new Intent("android.provider.action.PICK_IMAGES");
                intent.setType("image/*");
            } catch (RuntimeException e) {
                intent = null;
            }
            if (intent != null && !canHandle(intent)) {
                intent = null;
            }
        }
        if (intent == null) {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("image/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
        }
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        try {
            startActivityForResult(
                    Intent.createChooser(intent, getString(R.string.pick_file_title)),
                    FILE_CHOOSER_REQUEST);
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "no activity for file chooser", e);
            failFileChooser();
            return false;
        }
    }

    /** True when some app on the device can resolve {@code intent}. */
    private boolean canHandle(Intent intent) {
        try {
            List<ResolveInfo> matches = getPackageManager().queryIntentActivities(intent, 0);
            return matches != null && !matches.isEmpty();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private void failFileChooser() {
        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        if (callback != null) {
            callback.onReceiveValue(null);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        if (callback == null) {
            return;
        }
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null); // user cancelled: page must clear its spinner
            return;
        }
        Uri single = data.getData();
        ClipData clip = data.getClipData();
        Uri[] result;
        if (clip != null && clip.getItemCount() > 0) {
            int count = Math.min(clip.getItemCount(), 10);
            result = new Uri[count];
            for (int i = 0; i < count; i++) {
                result[i] = clip.getItemAt(i).getUri();
            }
        } else if (single != null) {
            result = new Uri[]{single};
        } else {
            result = null;
        }
        callback.onReceiveValue(result);
    }

    // ---------------------------------------------------------------- location

    /**
     * One-shot location fix for the page.
     *
     * <p>Order of operations matters for the privacy promise:
     * <ol>
     *   <li>A request id is required, because the answer is asynchronous and the page may have moved
     *       on (sheet closed, view destroyed). The id is echoed back with the fix.</li>
     *   <li>The runtime permission is requested first. If the user declines, nothing is read; the
     *       page gets {@code {"error":"denied"}} and can show "you can still type your area".</li>
     *   <li>Only then is a single provider asked for a last-known or fresh fix. The listener is
     *       removed as soon as one arrives, and a 20 s timeout guarantees it is always removed —
     *       a leaked listener would keep the GPS warm and drain the battery.</li>
     * </ol>
     *
     * <p>Precision is capped on purpose: {@code fine=false} asks for COARSE only and the result is
     * rounded to ~1 km (2 decimals). A "which area is my family in" feature has no business holding
     * a 5 m fix of a child's home.
     */
    private void requestLocation(String id, boolean fine) {
        String requestId = clip(trim(id), MAX_KEY_CHARS);
        if (requestId == null || requestId.isEmpty()) {
            return; // no correlation id, no answer
        }
        finishLocation(null, "superseded");
        pendingLocationId = requestId;
        pendingLocationFine = fine;
        String permission = fine ? Manifest.permission.ACCESS_FINE_LOCATION
                : Manifest.permission.ACCESS_COARSE_LOCATION;
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            try {
                requestPermissions(new String[]{permission}, REQ_LOCATION);
            } catch (RuntimeException e) {
                finishLocation(null, "unavailable");
            }
            return;
        }
        startLocationLookup();
    }

    private void startLocationLookup() {
        LocationManager manager;
        try {
            manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        } catch (RuntimeException e) {
            manager = null;
        }
        if (manager == null) {
            finishLocation(null, "unavailable");
            return;
        }
        String provider = null;
        String preferred = pendingLocationFine ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
        String fallback = LocationManager.NETWORK_PROVIDER;
        try {
            if (manager.isProviderEnabled(preferred)) {
                provider = preferred;
            } else if (manager.isProviderEnabled(fallback)) {
                provider = fallback;
            }
        } catch (RuntimeException e) {
            provider = null;
        }
        if (provider == null) {
            finishLocation(null, "disabled"); // location services off: point at system settings
            return;
        }
        Location last = null;
        try {
            last = manager.getLastKnownLocation(provider);
        } catch (SecurityException e) {
            last = null;
        } catch (RuntimeException e) {
            last = null;
        }
        if (last != null && System.currentTimeMillis() - last.getTime() < 120000L) {
            finishLocation(last, null); // recent enough: no need to wake the GPS
            return;
        }
        final LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                finishLocation(location, null);
            }

            @Override
            public void onProviderDisabled(String name) {
                finishLocation(null, "disabled");
            }

            @Override
            public void onProviderEnabled(String name) {
                // wait for the fix; the timeout still applies
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onStatusChanged(String name, int status, Bundle extras) {
                // no-op: onLocationChanged / the timeout decide the outcome
            }
        };
        pendingLocationListener = listener;
        try {
            manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper());
        } catch (SecurityException e) {
            finishLocation(null, "denied");
            return;
        } catch (RuntimeException e) {
            finishLocation(null, "unavailable");
            return;
        }
        mainHandler.postDelayed(locationTimeout, LOCATION_TIMEOUT_MS);
    }

    /**
     * Resolves the in-flight request exactly once: removes the listener, clears the timeout, then
     * hands {@code location} (or the failure {@code error}) to the page under its request id.
     */
    private void finishLocation(Location location, String error) {
        mainHandler.removeCallbacks(locationTimeout);
        String id = pendingLocationId;
        LocationListener listener = pendingLocationListener;
        pendingLocationId = null;
        pendingLocationListener = null;
        if (listener != null) {
            try {
                LocationManager manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
                if (manager != null) {
                    manager.removeUpdates(listener);
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "removeUpdates failed", e);
            }
        }
        if (id == null) {
            return; // nothing was pending; nothing to answer
        }
        if (location == null) {
            deliverLocation(id, "{\"id\":" + jsonString(id) + ",\"error\":"
                    + jsonString(error == null ? "unavailable" : error) + "}");
            return;
        }
        int decimals = pendingLocationFine ? 5 : 2;
        deliverLocation(id, "{\"id\":" + jsonString(id)
                + ",\"lat\":" + roundCoord(location.getLatitude(), decimals)
                + ",\"lon\":" + roundCoord(location.getLongitude(), decimals)
                + ",\"accuracy\":" + Math.round(location.getAccuracy())
                + ",\"ts\":" + location.getTime()
                + "}");
    }

    private void cancelLocation(String id) {
        String requestId = trim(id);
        if (pendingLocationId != null && pendingLocationId.equals(requestId)) {
            finishLocation(null, "cancelled");
        }
    }

    /** Rounds to {@code decimals} places and formats with Locale.US so JSON never sees a comma. */
    private static String roundCoord(double value, int decimals) {
        String formatted = String.format(Locale.US, "%." + decimals + "f", value);
        return formatted;
    }

    private void deliverLocation(final String id, final String json) {
        final WebView view = webView;
        if (view == null) {
            return; // page is gone; the fix dies with it
        }
        final String script = "(function(){try{if(window.FS&&typeof window.FS.nativeLocation==='function')"
                + "{window.FS.nativeLocation(" + json + ");}}catch(e){}})()";
        view.post(new Runnable() {
            @Override
            public void run() {
                WebView target = webView;
                if (target == null) {
                    return;
                }
                try {
                    target.evaluateJavascript(script, null);
                } catch (RuntimeException e) {
                    Log.w(TAG, "nativeLocation delivery failed", e);
                }
            }
        });
        Log.i(TAG, "location answered for " + clip(id, 40));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_LOCATION) {
            super.onRequestPermissionsResult(requestCode, permissions, results);
            return;
        }
        boolean granted = results != null && results.length > 0
                && results[0] == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            // Denied (or denied permanently): no fix is read at all. The page falls back to manual
            // entry, which is also what the app does on a device with location switched off.
            finishLocation(null, "denied");
            return;
        }
        startLocationLookup();
    }

    /** Minimal JSON string escaping — the bridge only ever emits ids we clipped ourselves. */
    private static String jsonString(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder(value.length() + 2);
        sb.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format(Locale.US, "\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private static boolean isNetworkScheme(String scheme) {
        return scheme != null
                && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
    }

    private static boolean startsWithNetworkScheme(String url) {
        return url != null
                && (url.regionMatches(true, 0, "http://", 0, 7)
                || url.regionMatches(true, 0, "https://", 0, 8));
    }

    // ---------------------------------------------------------------- intents

    /** Pulls text out of a SEND / VIEW launch intent. Returns true when new text was stored. */
    private boolean readIntentText(Intent intent) {
        if (intent == null) {
            return false;
        }
        String action = intent.getAction();
        String text = null;
        if (Intent.ACTION_SEND.equals(action)) {
            CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (extra == null) {
                ClipData clip = intent.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence item = clip.getItemAt(0).getText();
                    extra = item;
                }
            }
            text = extra == null ? null : extra.toString();
        } else if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            text = data == null ? null : data.toString();
        }
        if (text == null) {
            return false;
        }
        text = text.trim();
        if (text.isEmpty()) {
            return false;
        }
        if (text.length() > MAX_SHARED_CHARS) {
            text = text.substring(0, MAX_SHARED_CHARS);
        }
        synchronized (sharedLock) {
            pendingSharedText = text;
        }
        return true;
    }

    private void restoreSharedText(Bundle state) {
        if (state == null) {
            return;
        }
        String restored = state.getString(STATE_SHARED_TEXT);
        if (restored != null && !restored.isEmpty()) {
            synchronized (sharedLock) {
                pendingSharedText = restored;
            }
        }
    }

    // ------------------------------------------------------------ cloud messaging

    /** Used by {@link FsMessagingService} to choose in-app delivery over a tray notification. */
    static boolean isInForeground() {
        return appForeground;
    }

    /** Called by the messaging service when Firebase issues or rotates a token. */
    static void onFcmToken(String token) {
        if (token == null || token.isEmpty()) {
            return;
        }
        pendingPushToken = token;
        MainActivity host = currentActivity.get();
        if (host != null) {
            host.deliverPushToken(token);
        }
    }

    /** Called by the messaging service for a message received while the UI is alive. */
    static void onFcmMessage(String target) {
        MainActivity host = currentActivity.get();
        if (host != null && target != null && !target.isEmpty()) {
            host.deliverPushTarget(target);
        }
    }

    /**
     * Hands a token to {@code window.FS.push.onNativeToken}. The web layer owns backend
     * registration, so a token obtained before sign-in is never registered anonymously.
     */
    private void deliverPushToken(final String token) {
        if (token == null || token.isEmpty()) {
            return;
        }
        pendingPushToken = token;
        if (!pageReady) {
            return;
        }
        evaluateInPage("(function(){try{if(window.FS&&window.FS.push&&typeof "
                + "window.FS.push.onNativeToken==='function'){window.FS.push.onNativeToken('"
                + jsonEscape(token) + "');}}catch(e){}})()", "onNativeToken");
    }

    /** Hands a validated route to {@code window.FS.push.openTargetFor}. */
    private void deliverPushTarget(final String target) {
        String route = FsPush.sanitizeTarget(target);
        if (route == null || route.isEmpty()) {
            return;
        }
        pendingPushTarget = route;
        if (!pageReady) {
            return;
        }
        pendingPushTarget = null;
        evaluateInPage("(function(){try{if(window.FS&&window.FS.push&&typeof "
                + "window.FS.push.openTargetFor==='function'){window.FS.push.openTargetFor('"
                + jsonEscape(route) + "');}}catch(e){}})()", "openTargetFor");
    }

    private void flushPendingPush() {
        String target = pendingPushTarget;
        if (target != null) {
            pendingPushTarget = null;
            deliverPushTarget(target);
        }
        String token = pendingPushToken;
        if (token != null) {
            deliverPushToken(token);
        }
    }

    private void evaluateInPage(final String script, final String what) {
        final WebView view = webView;
        if (view == null) {
            return;
        }
        view.post(new Runnable() {
            @Override
            public void run() {
                WebView target = webView;
                if (target == null) {
                    return;
                }
                try {
                    target.evaluateJavascript(script, null);
                } catch (RuntimeException e) {
                    Log.w(TAG, what + " delivery failed", e);
                }
            }
        });
    }

    private void runOnUiThreadIfPossible(Runnable action) {
        WebView view = webView;
        if (view != null) {
            view.post(action);
        } else {
            runOnUiThread(action);
        }
    }

    private SharedPreferences store() {
        return getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static String clip(String value, int max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }

    /** Accepts http/https URLs with a host; everything else (file:, content:, intent:, javascript:) is refused. */
    private static Uri parseWebUri(String raw) {
        String value = trim(raw);
        if (value.isEmpty()) {
            return null;
        }
        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (RuntimeException e) {
            return null;
        }
        String scheme = uri.getScheme();
        if (!isNetworkScheme(scheme)) {
            return null;
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            return null;
        }
        return uri;
    }

    /** Keeps digits, '+', '*' and '#' only — enough for tel: and useless as an injection vector. */
    private static String sanitizePhone(String raw) {
        String value = trim(raw);
        if (value.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder(value.length());
        for (int i = 0; i < value.length() && sb.length() < 24; i++) {
            char c = value.charAt(i);
            if ((c >= '0' && c <= '9') || c == '+' || c == '*' || c == '#') {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String jsonEscape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        String hex = Integer.toHexString(c);
                        sb.append("\\u");
                        for (int pad = hex.length(); pad < 4; pad++) {
                            sb.append('0');
                        }
                        sb.append(hex);
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- JS bridge

    /** Injected as {@code window.FSAndroid}; called on the JavaBridge thread, so no UI here. */
    final class Bridge {

        @JavascriptInterface
        public void shareText(String title, String text) {
            // app.js calls shareText(title, text); tolerate a single argument too.
            String body = text == null ? trim(title) : text;
            if (body.isEmpty()) {
                return;
            }
            final String subject = title == null || trim(title).isEmpty()
                    ? getString(R.string.app_name) : trim(title);
            final String payload = body.length() > MAX_SHARED_CHARS
                    ? body.substring(0, MAX_SHARED_CHARS) : body;
            runOnUiThreadIfPossible(new ShareAction(MainActivity.this, subject, payload));
        }

        @JavascriptInterface
        public boolean copyText(String text) {
            String value = text == null ? "" : text;
            if (value.isEmpty()) {
                return false;
            }
            try {
                ClipboardManager clipboard =
                        (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null) {
                    return false;
                }
                clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), value));
                return true;
            } catch (RuntimeException e) {
                Log.w(TAG, "clipboard unavailable", e);
                return false;
            }
        }

        /**
         * Returns the clipboard's plain text for the "Paste" button. WebView's async Clipboard API
         * is unavailable on the {@code file://} origin the app loads from, so the shell reads the
         * clipboard natively. Android 10+ only exposes the clipboard to the focused app; a
         * {@code null} return means "nothing readable", never an error the user should see.
         */
        @JavascriptInterface
        public String readClipboard() {
            try {
                ClipboardManager clipboard =
                        (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null || !clipboard.hasPrimaryClip()) {
                    return "";
                }
                ClipData clip = clipboard.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) {
                    return "";
                }
                CharSequence text = clip.getItemAt(0).coerceToText(MainActivity.this);
                String value = text == null ? "" : text.toString();
                // Scam texts are short; refuse a runaway clipboard instead of copying a novel in.
                return value.length() > MAX_PASTED_CHARS
                        ? value.substring(0, MAX_PASTED_CHARS) : value;
            } catch (RuntimeException e) {
                Log.w(TAG, "clipboard read unavailable", e);
                return "";
            }
        }

        @JavascriptInterface
        public boolean openUrl(String url) {
            final Uri uri = parseWebUri(url);
            if (uri == null) {
                return false;
            }
            runOnUiThreadIfPossible(new OpenUrlAction(MainActivity.this, uri));
            return true;
        }

        @JavascriptInterface
        public boolean dial(String number) {
            final String digits = sanitizePhone(number);
            if (digits.isEmpty()) {
                return false;
            }
            // ACTION_DIAL only: the app never places a call by itself.
            runOnUiThreadIfPossible(new DialAction(MainActivity.this, digits));
            return true;
        }

        /**
         * Posts a system notification for a server-confirmed event: the user's own alert reaching
         * a family member, a family alert arriving, or an accepted nearby helper responding.
         *
         * <p>Only the web layer decides what is true — this method never invents an event, it just
         * mirrors the text it is given. Returns {@code false} when notifications are refused or the
         * platform has no notification service, so callers can show their in-app state instead.
         * On API 33+ the first call raises the POST_NOTIFICATIONS prompt and returns false; the
         * caller retries after the user answers, if it wants the confirmation.
         */
        @JavascriptInterface
        public boolean showNotification(String title, String body) {
            String heading = trim(title);
            String text = trim(body);
            if (heading.isEmpty()) {
                heading = getString(R.string.app_name);
            }
            if (heading.length() > MAX_NOTIFICATION_TITLE) {
                heading = heading.substring(0, MAX_NOTIFICATION_TITLE);
            }
            if (text.length() > MAX_NOTIFICATION_BODY) {
                text = text.substring(0, MAX_NOTIFICATION_BODY);
            }
            if (!hasNotificationPermission()) {
                return false;
            }
            postNotification(heading, text);
            return true;
        }

        private boolean hasNotificationPermission() {
            if (Build.VERSION.SDK_INT < 33) {
                return true;
            }
            if (MainActivity.this.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
            synchronized (MainActivity.this) {
                if (notificationPermissionAsked) {
                    return false;
                }
                notificationPermissionAsked = true;
            }
            runOnUiThreadIfPossible(new Runnable() {
                @Override
                public void run() {
                    try {
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                                REQ_NOTIFICATIONS);
                    } catch (RuntimeException e) {
                        Log.w(TAG, "notification permission request failed", e);
                    }
                }
            });
            return false;
        }

        private void postNotification(final String title, final String body) {
            runOnUiThreadIfPossible(new Runnable() {
                @Override
                public void run() {
                    try {
                        NotificationManager manager = (NotificationManager)
                                getSystemService(Context.NOTIFICATION_SERVICE);
                        if (manager == null) {
                            return;
                        }
                        Intent open = new Intent(MainActivity.this, MainActivity.class);
                        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                        if (Build.VERSION.SDK_INT >= 23) {
                            flags |= PendingIntent.FLAG_IMMUTABLE;
                        }
                        PendingIntent contentIntent = PendingIntent.getActivity(
                                MainActivity.this, 0, open, flags);

                        Notification.Builder builder;
                        if (Build.VERSION.SDK_INT >= 26) {
                            NotificationChannel channel = new NotificationChannel(
                                    CHANNEL_ALERTS,
                                    getString(R.string.app_name) + " alerts",
                                    NotificationManager.IMPORTANCE_HIGH);
                            channel.setDescription(
                                    "Family alerts and nearby-helper updates you opted into");
                            channel.enableVibration(true);
                            manager.createNotificationChannel(channel);
                            builder = new Notification.Builder(MainActivity.this, CHANNEL_ALERTS);
                        } else {
                            builder = new Notification.Builder(MainActivity.this);
                            builder.setPriority(Notification.PRIORITY_HIGH);
                        }
                        builder.setSmallIcon(R.mipmap.ic_launcher)
                                .setContentTitle(title)
                                .setContentText(body)
                                .setStyle(new Notification.BigTextStyle().bigText(body))
                                .setAutoCancel(true)
                                .setContentIntent(contentIntent)
                                .setWhen(System.currentTimeMillis());
                        manager.notify(NOTIFICATION_BASE_ID + (notificationSequence++ % 50),
                                builder.build());
                    } catch (RuntimeException e) {
                        Log.w(TAG, "notification unavailable", e);
                    }
                }
            });
        }

        /**
         * Current FCM registration token, or {@code ""} before Firebase has issued one. The page
         * registers it with the backend only after the user is authenticated.
         */
        @JavascriptInterface
        public String getFcmToken() {
            String token = FsPush.storedToken(MainActivity.this);
            return token == null ? "" : token;
        }

        /**
         * Records which FamilyShield account owns this device token so a logout or account switch
         * can ask the backend to drop the old binding. An empty id clears the local association.
         */
        @JavascriptInterface
        public void setFcmUser(String userId) {
            String id = clip(trim(userId), 64);
            if (id.isEmpty()) {
                FsPush.clearTokenUser(MainActivity.this);
            } else {
                FsPush.markTokenUser(MainActivity.this, id);
            }
        }

        @JavascriptInterface
        public String consumeSharedText() {
            synchronized (sharedLock) {
                String text = pendingSharedText;
                pendingSharedText = null;
                return text == null ? "" : text;
            }
        }

        @JavascriptInterface
        public String platformInfo() {
            String locale;
            try {
                locale = Locale.getDefault().toLanguageTag();
            } catch (RuntimeException e) {
                locale = "en";
            }
            return "{\"platform\":\"android\""
                    + ",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"release\":\"" + jsonEscape(Build.VERSION.RELEASE) + "\""
                    + ",\"manufacturer\":\"" + jsonEscape(Build.MANUFACTURER) + "\""
                    + ",\"brand\":\"" + jsonEscape(Build.BRAND) + "\""
                    + ",\"model\":\"" + jsonEscape(Build.MODEL) + "\""
                    + ",\"device\":\"" + jsonEscape(Build.DEVICE) + "\""
                    + ",\"packageName\":\"" + jsonEscape(getPackageName()) + "\""
                    + ",\"appVersion\":\"" + APP_VERSION + "\""
                    + ",\"versionCode\":1"
                    + ",\"locale\":\"" + jsonEscape(locale) + "\""
                    + ",\"offline\":true}";
        }

        @JavascriptInterface
        public void log(String text) {
            String line = clip(text, MAX_LOG_CHARS);
            if (line == null || line.isEmpty()) {
                return;
            }
            Log.i(TAG, line);
        }

        @JavascriptInterface
        public String storeGet(String key) {
            String safeKey = clip(trim(key), MAX_KEY_CHARS);
            if (safeKey.isEmpty()) {
                return null;
            }
            try {
                return store().getString(safeKey, null);
            } catch (RuntimeException e) {
                Log.w(TAG, "storeGet failed for " + safeKey, e);
                return null;
            }
        }

        @JavascriptInterface
        public boolean storeSet(String key, String json) {
            String safeKey = clip(trim(key), MAX_KEY_CHARS);
            if (safeKey.isEmpty()) {
                return false;
            }
            if (json != null && json.length() > MAX_STORE_CHARS) {
                // Previously the payload was clipped here. For values (history JSON) a clipped
                // write is worse than a refused one: storeGet then hands the web layer a string
                // that can never parse again, and nothing can repair it. Keep the last good value.
                Log.w(TAG, "storeSet rejected oversized value for " + safeKey);
                return false;
            }
            String value = json == null ? "" : json;
            try {
                // commit() (not apply()) so a read straight after a write in the same session is safe.
                return store().edit().putString(safeKey, value).commit();
            } catch (RuntimeException e) {
                Log.w(TAG, "storeSet failed for " + safeKey, e);
                return false;
            }
        }

        /** Configured backend origin, or {@code ""} when Settings has never set one. */
        @JavascriptInterface
        public String getBackendOrigin() {
            return backendOrigin();
        }

        /** Build version shown in Settings; mirrors {@code android:versionName}. */
        @JavascriptInterface
        public String versionName() {
            return APP_VERSION;
        }

        /**
         * Validates and stores the backend origin. Returns {@code ""} on success, otherwise a short
         * reason string the Settings view shows verbatim.
         *
         * <p>Qualified with {@code MainActivity.this} on purpose: this bridge method shadows the
         * activity method of the same name, so an unqualified call would recurse.
         */
        @JavascriptInterface
        public String setBackendOrigin(String origin) {
            return MainActivity.this.setBackendOrigin(origin);
        }

        /**
         * One-shot location fix, answered asynchronously through
         * {@code window.FS.nativeLocation(json)} under the same {@code id}.
         *
         * <p>Hopped to the main thread first: {@code requestPermissions()} may only be called from
         * the main thread (the permission result is what starts the lookup), and once registered the
         * LocationManager listener lives on the main looper, where {@code finishLocation()} runs.
         */
        @JavascriptInterface
        public void requestLocation(String id, boolean fine) {
            mainHandler.post(new LocationRequestAction(MainActivity.this, id, fine));
        }

        /**
         * Drops the in-flight request under {@code id}; the page is answered with
         * {@code {"error":"cancelled"}} so a closed sheet never waits for the timeout.
         */
        @JavascriptInterface
        public void cancelLocation(String id) {
            mainHandler.post(new LocationCancelAction(MainActivity.this, id));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Callbacks used by the bridge.
    //
    // These are deliberately written as named inner classes rather than anonymous classes: the
    // anonymous form produces synthetic holders that were the source of an R8/d8 failure in this
    // toolchain, and named classes with an explicit host field also avoid capturing the activity
    // through an implicit outer reference.
    // ---------------------------------------------------------------------------------------------

    /** Finishes the activity unless the web layer handled the back press itself. */
    static final class BackCallback implements ValueCallback<String> {
        private final MainActivity host;

        BackCallback(MainActivity host) {
            this.host = host;
        }

        @Override
        public void onReceiveValue(String value) {
            if (host == null) {
                return;
            }
            // evaluateJavascript returns the JS value as a JSON-ish string, so true === "true".
            if (!"true".equals(value)) {
                host.finish();
            }
        }
    }

    /** Opens the system share sheet for the given subject/text pair. */
    private static final class ShareAction implements Runnable {
        private final MainActivity host;
        private final String subject;
        private final String payload;

        ShareAction(MainActivity host, String subject, String payload) {
            this.host = host;
            this.subject = subject;
            this.payload = payload;
        }

        @Override
        public void run() {
            if (host == null) {
                return;
            }
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_SUBJECT, subject);
            send.putExtra(Intent.EXTRA_TEXT, payload);
            Intent chooser = Intent.createChooser(send, host.getString(R.string.chooser_title));
            try {
                host.startActivity(chooser);
            } catch (RuntimeException e) {
                Log.w(TAG, "share sheet unavailable", e);
            }
        }
    }

    /** Hands a validated http/https URI to the user's browser. */
    private static final class OpenUrlAction implements Runnable {
        private final MainActivity host;
        private final Uri uri;

        OpenUrlAction(MainActivity host, Uri uri) {
            this.host = host;
            this.uri = uri;
        }

        @Override
        public void run() {
            if (host == null || uri == null) {
                return;
            }
            Intent view = new Intent(Intent.ACTION_VIEW, uri);
            try {
                host.startActivity(view);
            } catch (RuntimeException e) {
                Log.w(TAG, "no browser for " + uri, e);
            }
        }
    }

    /** Opens the dialer with the number pre-filled; never places the call. */
    private static final class DialAction implements Runnable {
        private final MainActivity host;
        private final String digits;

        DialAction(MainActivity host, String digits) {
            this.host = host;
            this.digits = digits;
        }

        @Override
        public void run() {
            if (host == null) {
                return;
            }
            Intent dial = new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", digits, null));
            try {
                host.startActivity(dial);
            } catch (RuntimeException e) {
                Log.w(TAG, "no dialer for " + digits, e);
            }
        }
    }

    /**
     * Starts a one-shot location request on the main thread. The permission prompt and the
     * LocationManager listener are both main-thread objects, but the bridge that asks for them runs
     * on the JavaBridge thread.
     */
    private static final class LocationRequestAction implements Runnable {
        private final MainActivity host;
        private final String id;
        private final boolean fine;

        LocationRequestAction(MainActivity host, String id, boolean fine) {
            this.host = host;
            this.id = id;
            this.fine = fine;
        }

        @Override
        public void run() {
            if (host == null) {
                return;
            }
            host.requestLocation(id, fine);
        }
    }

    /** Cancels a pending location request on the main thread, so it races nothing in finish. */
    private static final class LocationCancelAction implements Runnable {
        private final MainActivity host;
        private final String id;

        LocationCancelAction(MainActivity host, String id) {
            this.host = host;
            this.id = id;
        }

        @Override
        public void run() {
            if (host == null) {
                return;
            }
            host.cancelLocation(id);
        }
    }
}
