package kg.flash.paymentreader

import android.content.Context
import java.util.UUID

data class ReaderConfig(
    val baseUrl: String,
    val deviceId: String,
    val token: String,
)

object ReaderSettings {
    private const val PREFS = "reader_config"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_TOKEN = "token"

    fun load(context: Context): ReaderConfig {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val deviceId = prefs.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE_ID, it).apply()
        }
        return ReaderConfig(
            baseUrl = prefs.getString(KEY_BASE_URL, "") ?: "",
            deviceId = deviceId,
            token = prefs.getString(KEY_TOKEN, "") ?: "",
        )
    }

    fun save(context: Context, baseUrl: String, deviceId: String, token: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_BASE_URL, baseUrl.trim().trimEnd('/'))
            .putString(KEY_DEVICE_ID, deviceId.trim())
            .putString(KEY_TOKEN, token.trim())
            .apply()
    }
}
