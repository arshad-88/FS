package com.familyshield.app;

import android.util.Log;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives Firebase Cloud Messaging traffic for FamilyShield.
 *
 * <p>Three paths matter:
 * <ul>
 *   <li>{@link #onNewToken(String)} — the registration token was created or rotated. It is cached
 *       and forwarded to the web layer, which registers it with the authenticated backend.</li>
 *   <li>{@link #onMessageReceived(RemoteMessage)} — only called for data-only messages while
 *       backgrounded, and for every message while the app is in the foreground. When the UI is
 *       alive the payload is handed straight to {@code window.FS.push}, otherwise a tray
 *       notification is posted so the alert is not lost.</li>
 *   <li>Notification-plus-data messages sent while backgrounded are drawn by the Firebase SDK
 *       itself (the manifest provides the default icon and channel). Tapping any of these
 *       launches MainActivity with the data extras, which MainActivity validates and routes.</li>
 * </ul>
 *
 * <p>Nothing here trusts an identifier: {@link FsPush#targetFor(Map)} only maps the three server
 * payload kinds, and the backend re-checks ownership before returning the request.
 */
public class FsMessagingService extends FirebaseMessagingService {

    private static final String TAG = "FamilyShield";

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        if (token == null || token.isEmpty()) return;
        FsPush.storeToken(getApplicationContext(), token);
        MainActivity.onFcmToken(token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String type = data == null ? "" : String.valueOf(data.get("type"));
        String target = FsPush.targetFor(data);

        RemoteMessage.Notification notification = message.getNotification();
        String title = notification != null && notification.getTitle() != null
                ? notification.getTitle()
                : (data == null ? null : data.get("title"));
        String body = notification != null && notification.getBody() != null
                ? notification.getBody()
                : (data == null ? null : data.get("body"));

        Log.i(TAG, "FCM message type=" + type + " foreground=" + MainActivity.isInForeground());

        if (MainActivity.isInForeground()) {
            /* The page is alive, so refresh the panel in place instead of stacking a tray item
             * the user has already seen. */
            MainActivity.onFcmMessage(target);
            return;
        }

        if (!FsPush.canNotify(this)) {
            /* Without POST_NOTIFICATIONS the tray write is a no-op; keep the payload in the log
             * so a support run can still see that delivery happened. */
            Log.w(TAG, "FCM message dropped: notification permission not granted");
            return;
        }
        FsPush.post(this, title, body, target);
    }
}
