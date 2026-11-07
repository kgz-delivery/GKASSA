package kg.flash.paymentreader

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class BankTemplate(
    val bankCode: String,
    val packageName: String,
    val regexAmount: String,
    val regexSender: String?,
    val isActive: Boolean,
)

data class ParsedPayment(val amount: String, val sender: String?)

object PaymentApi {
    fun getTemplates(config: ReaderConfig): List<BankTemplate> {
        val response = request(config, "GET", "/api/templates")
        val rows = JSONArray(response)
        return buildList {
            for (index in 0 until rows.length()) {
                val row = rows.getJSONObject(index)
                add(
                    BankTemplate(
                        bankCode = row.optString("bank_code"),
                        packageName = row.optString("package_name"),
                        regexAmount = row.optString("regex_amount"),
                        regexSender = row.optString("regex_sender").takeIf { it.isNotBlank() },
                        isActive = row.optInt("is_active", 0) == 1,
                    )
                )
            }
        }
    }

    fun sendPayment(config: ReaderConfig, template: BankTemplate, event: QueuedNotification, parsed: ParsedPayment): String {
        val body = JSONObject()
            .put("device_id", config.deviceId)
            .put("bank_code", template.bankCode)
            .put("package_name", event.packageName)
            .put("amount", parsed.amount)
            .put("sender", parsed.sender ?: JSONObject.NULL)
            .put("raw_text", event.rawText)
            .put("received_at", event.receivedAt)
            .put("hash", event.hash)
        return JSONObject(request(config, "POST", "/api/payments", body.toString())).optString("status")
    }

    fun sendRawLog(config: ReaderConfig, event: QueuedNotification) {
        val body = JSONObject()
            .put("device_id", config.deviceId)
            .put("package_name", event.packageName)
            .put("raw_text", event.rawText)
            .put("received_at", event.receivedAt)
        request(config, "POST", "/api/raw-logs", body.toString())
    }

    fun sendHeartbeat(config: ReaderConfig, context: android.content.Context) {
        val batteryStatus = context.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        val battery = batteryStatus?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryStatus?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
        val percent = if (battery >= 0 && scale > 0) (battery * 100) / scale else -1
        val appVersion = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        val body = JSONObject()
            .put("device_id", config.deviceId)
            .put("battery", if (percent >= 0) percent else JSONObject.NULL)
            .put("app_version", appVersion)
        request(config, "POST", "/api/heartbeat", body.toString())
    }

    private fun request(config: ReaderConfig, method: String, path: String, body: String? = null): String {
        require(config.baseUrl.startsWith("https://", ignoreCase = true)) {
            "Укажи HTTPS-адрес Render, начинающийся с https://"
        }
        val connection = URL(config.baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 12_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("X-Device-Id", config.deviceId)
            connection.setRequestProperty("X-Token", config.token)
            connection.setRequestProperty("Accept", "application/json")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { output -> output.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw IllegalStateException("Сервер ответил HTTP $status: ${response.take(300)}")
            return response
        } finally {
            connection.disconnect()
        }
    }
}
