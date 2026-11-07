package kg.flash.paymentreader

import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.TimeUnit

class PaymentNotificationListener : NotificationListenerService() {
    private val handler = Handler(Looper.getMainLooper())
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            enqueueHeartbeat()
            handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        handler.removeCallbacks(heartbeatRunnable)
        handler.post(heartbeatRunnable)
    }

    override fun onListenerDisconnected() {
        handler.removeCallbacks(heartbeatRunnable)
        requestRebind(ComponentName(this, PaymentNotificationListener::class.java))
        super.onListenerDisconnected()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != OPTIMA_PACKAGE_NAME) return
        val extras = sbn.notification.extras
        val pieces = listOf(
            extras.getCharSequence("android.title"),
            extras.getCharSequence("android.text"),
            extras.getCharSequence("android.bigText"),
            extras.getCharSequence("android.summaryText"),
        ).mapNotNull { it?.toString()?.trim()?.takeIf(String::isNotBlank) }.distinct()
        val rawText = pieces.joinToString("\n").take(MAX_NOTIFICATION_CHARS)
        if (rawText.isBlank()) return

        val config = ReaderSettings.load(this)
        val identity = "${config.deviceId}|${sbn.key}|${sbn.postTime}|$rawText"
        val event = QueuedNotification(
            hash = sha256(identity),
            packageName = sbn.packageName,
            rawText = rawText,
            receivedAt = Instant.ofEpochMilli(sbn.postTime).toString(),
        )
        val store = NotificationStore(this)
        val inserted = runCatching { store.enqueue(event) }.getOrDefault(false)
        store.close()
        if (inserted) enqueuePaymentQueue()
    }

    override fun onDestroy() {
        handler.removeCallbacks(heartbeatRunnable)
        super.onDestroy()
    }

    private fun enqueuePaymentQueue() {
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val request = OneTimeWorkRequestBuilder<PaymentQueueWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(this).enqueueUniqueWork(QUEUE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    private fun enqueueHeartbeat() {
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val request = OneTimeWorkRequestBuilder<HeartbeatWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(this).enqueueUniqueWork(HEARTBEAT_WORK, ExistingWorkPolicy.REPLACE, request)
    }

    private fun sha256(input: String): String = MessageDigest.getInstance("SHA-256")
        .digest(input.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    companion object {
        private const val OPTIMA_PACKAGE_NAME = "kz.optimabank.optima24"
        private const val MAX_NOTIFICATION_CHARS = 10_000
        private const val HEARTBEAT_INTERVAL_MS = 60_000L
        private const val QUEUE_WORK = "payment-queue"
        private const val HEARTBEAT_WORK = "reader-heartbeat"
    }
}
