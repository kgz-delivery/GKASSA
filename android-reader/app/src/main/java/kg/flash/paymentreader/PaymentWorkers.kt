package kg.flash.paymentreader

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class PaymentQueueWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val config = ReaderSettings.load(applicationContext)
        if (config.baseUrl.isBlank() || config.deviceId.isBlank() || config.token.isBlank()) return@withContext Result.failure()
        val store = NotificationStore(applicationContext)
        try {
            val templates = PaymentApi.getTemplates(config)
            for (event in store.pending()) {
                val template = templates.firstOrNull {
                    it.isActive && it.bankCode == "optima" && it.packageName == event.packageName
                }
                if (template == null) {
                    PaymentApi.sendRawLog(config, event)
                    store.remove(event.hash)
                    continue
                }

                val parsed = BankPushParser.parse(template, event.rawText)
                if (parsed == null) {
                    PaymentApi.sendRawLog(config, event)
                    store.remove(event.hash)
                    continue
                }

                val result = PaymentApi.sendPayment(config, template, event, parsed)
                if (result !in setOf("matched", "unmatched", "duplicate")) {
                    throw IllegalStateException("Неожиданный ответ сервера: $result")
                }
                store.remove(event.hash)
            }
            Result.success()
        } catch (error: Exception) {
            android.util.Log.w("PaymentReader", "Очередь сохранена, повторю отправку: ${error.message}")
            Result.retry()
        } finally {
            store.close()
        }
    }
}

class HeartbeatWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val config = ReaderSettings.load(applicationContext)
        if (config.baseUrl.isBlank() || config.deviceId.isBlank() || config.token.isBlank()) return@withContext Result.failure()
        try {
            PaymentApi.sendHeartbeat(config, applicationContext)
            Result.success()
        } catch (error: Exception) {
            android.util.Log.w("PaymentReader", "Heartbeat отправится повторно: ${error.message}")
            Result.retry()
        }
    }
}
