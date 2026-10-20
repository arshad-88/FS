package com.familyshield.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import java.util.Locale;
import java.util.Map;

/**
 * Firebase Cloud Messaging plumbing shared by {@link FsMessagingService} and the WebView bridge.
 *
 * <p>Everything here degrades quietly when the app was built without {@code google-services.json}:
 * {@link #requestToken(Context)} returns without touching Firebase, the JS bridge keeps receiving
 * an empty token, and no notification is posted. A missing Firebase configuration must never stop
 * the emergency screens from working.
 *
 * <p>Payload contract with {@code server/providers.js}: a message carries a {@code data} block
 * whose {@code type} is one of {@code family_emergency}, {@code helper_request} or
 * {@code family_request} plus the matching id. The server sends a human-readable
 * {@code notification} block too, but the tray notification is always rebuilt locally so the
 * lock screen shows a neutral summary and the tap target is validated before it reaches the
 * router.
 */
final class FsPush {

    private static final String TAG = "FamilyShield";

    /** Same channel id as {@link MainActivity#CHANNEL_ALERTS} so one channel serves both paths. */
    static final String CHANNEL_ALERTS = "familyshield_alerts";

    /**
     * Intent extra carrying a validated in-app target ({@code emergency/<id>},
     * {@code helper/<id>}). Never a URL: MainActivity only forwards whitelisted routes.
     */
    static final String EXTRA_TARGET = "familyshield.push.target";

    private static final String PREFS = "fs_push";
    private static final String KEY_TOKEN = "fcm_token";
    private static final String KEY_TOKEN_USER = "fcm_token_user";

    private static final int NOTIFICATION_BASE_ID = 0x4700;
    private static final int MAX_TITLE = 120;
    private static final int MAX_BODY = 500;
    private static final int MAX_ID = 64;

    private static int notificationSequence;

    private FsPush() {
    }

    /* ------------------------------------------------------------------ token */

    /** Last token Firebase handed us, or "" when push is not configured yet. */
    static String storedToken(Context context) {
        if (context == null) return "";
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return prefs.getString(KEY_TOKEN, "");
        } catch (RuntimeException err) {
            return "";
        }
    }

    /** Which account the stored token belongs to, so logout can drop the right row. */
    static String storedTokenUser(Context context) {
        if (context == null) return "";
        try {
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_TOKEN_USER, "");
        } catch (RuntimeException err) {
            return "";
        }
    }

    static void storeToken(Context context, String token) {
        if (context == null || token == null || token.isEmpty()) return;
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_TOKEN, token)
                    .apply();
        } catch (RuntimeException err) {
            Log.w(TAG, "push token store failed", err);
        }
    }

    /** Forget the token association after logout; the token itself stays cached. */
    static void clearTokenUser(Context context) {
        if (context == null) return;
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .remove(KEY_TOKEN_USER)
                    .apply();
        } catch (RuntimeException err) {
            Log.w(TAG, "push token user clear failed", err);
        }
    }

    /** Remember who registered the cached token so a later logout can unregister it. */
    static void markTokenUser(Context context, String userId) {
        if (context == null) return;
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_TOKEN_USER, userId == null ? "" : userId)
                    .apply();
        } catch (RuntimeException err) {
            Log.w(TAG, "push token user store failed", err);
        }
    }

    /** True when a Firebase app exists (google-services.json was baked into the APK). */
    static boolean configured(Context context) {
        if (context == null) return false;
        try {
            return !FirebaseApp.getApps(context).isEmpty();
        } catch (RuntimeException err) {
            return false;
        }
    }

    /**
     * Ask Firebase for the current registration token. The result is handed to
     * {@link MainActivity#onFcmToken(String)} on the main thread; the JS bridge reads it from
     * there rather than blocking the JavaBridge thread on a network call.
     */
    static void requestToken(Context context) {
        final Context app = context == null ? null : context.getApplicationContext();
        if (app == null || !configured(app)) return;
        try {
            FirebaseMessaging.getInstance().getToken()
                    .addOnSuccessListener(token -> MainActivity.onFcmToken(token))
                    .addOnFailureListener(err -> Log.w(TAG, "FCM getToken failed: " + err.getClass().getSimpleName()));
        } catch (RuntimeException err) {
            Log.w(TAG, "FCM getToken unavailable: " + err.getClass().getSimpleName());
        }
    }

    /* ----------------------------------------------------------------- target */

    /**
     * Map a server data payload onto a router target. Only the three server-known kinds and a
     * bounded id survive; anything else (or a forged id) is dropped instead of opening a screen.
     */
    static String targetFor(Map<String, String> data) {
        if (data == null) return null;
        String type = lower(data.get("type"));
        String target;
        if ("family_emergency".equals(type)) {
            target = bounded("emergency", data.get("emergencyId"));
        } else if ("helper_request".equals(type)) {
            target = bounded("helper", data.get("assignmentId"));
        } else if ("family_request".equals(type)) {
            target = "family";
        } else {
            return null;
        }
        return target;
    }

    /** Read a target from a launcher intent (tray tap) without trusting arbitrary strings. */
    static String targetFromIntent(Intent intent) {
        if (intent == null) return null;
        String raw = intent.getStringExtra(EXTRA_TARGET);
        return sanitizeTarget(raw);
    }

    /**
     * Allow {@code <route>} or {@code <route>/<id>} for a route the app really has, with an id
     * drawn from a conservative character set. Everything else returns null.
     */
    static String sanitizeTarget(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        if (text.isEmpty() || text.length() > MAX_ID + 16) return null;
        String route;
        String id = "";
        int slash = text.indexOf('/');
        if (slash < 0) {
            route = text;
        } else {
            route = text.substring(0, slash);
            id = text.substring(slash + 1);
        }
        route = lower(route);
        boolean known = "emergency".equals(route) || "helper".equals(route) || "family".equals(route);
        if (!known) return null;
        if (!id.isEmpty()) {
            if (id.length() > MAX_ID) return null;
            for (int i = 0; i < id.length(); i++) {
                char ch = id.charAt(i);
                boolean ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
                        || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '@';
                if (!ok) return null;
            }
        }
        return id.isEmpty() ? route : route + "/" + id;
    }

    private static String bounded(String route, String id) {
        String safe = sanitizeTarget(id == null ? "" : (route + "/" + id));
        return safe;
    }

    private static String lower(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.US);
    }

    /* ----------------------------------------------------------- notification */

    /**
     * Show a tray notification whose tap reopens {@link MainActivity} with a validated target.
     *
     * <p>The public (lock screen) version never repeats the alert text: it says only that
     * FamilyShield needs attention, so a bystander cannot read who is in danger or why.
     */
    static void post(Context context, String title, String body, String target) {
        if (context == null) return;
        String safeTarget = sanitizeTarget(target);
        String safeTitle = clip(title, MAX_TITLE, "FamilyShield");
        String safeBody = clip(body, MAX_BODY, "Tap to open FamilyShield.");
        try {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            ensureChannel(context, manager);

            Intent open = new Intent(context, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (safeTarget != null) open.putExtra(EXTRA_TARGET, safeTarget);
            int requestCode = NOTIFICATION_BASE_ID + (safeTarget == null ? 0 : safeTarget.hashCode());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(context, requestCode, open, flags);

            Notification.Builder builder = newBuilder(context, manager)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(safeTitle)
                    .setContentText(safeBody)
                    .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .setCategory(Notification.CATEGORY_RECOMMENDATION);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                builder.setColor(0xFFB3261E);
            }
            builder.setPublicVersion(newBuilder(context, manager)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("FamilyShield")
                    .setContentText("Tap to open FamilyShield.")
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .build());

            synchronized (FsPush.class) {
                notificationSequence = (notificationSequence + 1) % 64;
            }
            manager.notify(NOTIFICATION_BASE_ID + notificationSequence, builder.build());
        } catch (RuntimeException err) {
            /* A notification that cannot be shown must not take the process down. */
            Log.w(TAG, "FCM notification failed", err);
        }
    }

    private static void ensureChannel(Context context, NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (manager.getNotificationChannel(CHANNEL_ALERTS) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ALERTS,
                "Emergency alerts", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Family emergency and nearby helper alerts");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            channel.setShowBadge(true);
        }
        manager.createNotificationChannel(channel);
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder newBuilder(Context context, NotificationManager manager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(context, CHANNEL_ALERTS);
        }
        return new Notification.Builder(context);
    }

    /** Notification permission state (API 33+ requires runtime consent). */
    static boolean canNotify(Context context) {
        if (context == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return context.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private static String clip(String value, int max, String fallback) {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) return fallback;
        return text.length() <= max ? text : text.substring(0, max - 1) + "\u2026";
    }
}
