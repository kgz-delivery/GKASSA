package kg.flash.paymentreader

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var baseUrlInput: EditText
    private lateinit var deviceIdInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildScreen()
        val config = ReaderSettings.load(this)
        baseUrlInput.setText(config.baseUrl)
        deviceIdInput.setText(config.deviceId)
        tokenInput.setText(config.token)
        updateListenerStatus()
    }

    override fun onResume() {
        super.onResume()
        if (::statusText.isInitialized) updateListenerStatus()
    }

    private fun buildScreen() {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(28))
        }

        content.addView(TextView(this).apply {
            text = "Flash — читалка платежей"
            textSize = 24f
            setTextColor(0xff14243a.toInt())
        })
        content.addView(TextView(this).apply {
            text = "Сначала укажи адрес сервера и токен. Потом включи доступ к уведомлениям Optima."
            textSize = 15f
            setPadding(0, dp(10), 0, dp(18))
        })

        baseUrlInput = addInput(content, "Адрес backend на Render", "https://example.onrender.com")
        deviceIdInput = addInput(content, "ID этого телефона", "reader-01")
        tokenInput = addInput(content, "Общий токен устройства", "Вставь токен из Render").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        content.addView(makeButton("1. Сохранить настройки") { saveSettings() })
        content.addView(makeButton("2. Разрешить чтение уведомлений") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        })
        content.addView(makeButton("3. Проверить соединение с сервером") { checkConnection() })
        content.addView(makeButton("Отправить сохранённую очередь") { enqueuePendingEvents() })

        statusText = TextView(this).apply {
            textSize = 15f
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(18), dp(4), 0)
        }
        content.addView(statusText)

        val scroll = ScrollView(this).apply { addView(content) }
        setContentView(scroll)
    }

    private fun addInput(parent: LinearLayout, label: String, hint: String): EditText {
        parent.addView(TextView(this).apply {
            text = label
            textSize = 14f
            setPadding(0, dp(8), 0, dp(4))
        })
        return EditText(this).also { input ->
            input.hint = hint
            input.textSize = 16f
            input.maxLines = 1
            parent.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54)))
        }
    }

    private fun makeButton(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(8) }
    }

    private fun saveSettings() {
        val baseUrl = baseUrlInput.text.toString().trim().trimEnd('/')
        val deviceId = deviceIdInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()
        if (!baseUrl.startsWith("https://") || deviceId.isBlank() || token.isBlank()) {
            statusText.text = "Заполни HTTPS-адрес, ID телефона и токен."
            return
        }
        ReaderSettings.save(this, baseUrl, deviceId, token)
        statusText.text = "Настройки сохранены. Пакет Optima: kz.optimabank.optima24"
        enqueuePendingEvents()
    }

    private fun checkConnection() {
        val config = currentConfig() ?: return
        statusText.text = "Проверяю сервер…"
        executor.execute {
            runCatching { PaymentApi.getTemplates(config) }
                .onSuccess { templates -> runOnUiThread { statusText.text = "Связь есть. Шаблонов: ${templates.size}." } }
                .onFailure { error -> runOnUiThread { statusText.text = "Не получилось подключиться: ${error.message}" } }
        }
    }

    private fun enqueuePendingEvents() {
        val request = androidx.work.OneTimeWorkRequestBuilder<PaymentQueueWorker>()
            .setConstraints(androidx.work.Constraints.Builder()
                .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED).build())
            .build()
        androidx.work.WorkManager.getInstance(this).enqueueUniqueWork(
            "payment-queue", androidx.work.ExistingWorkPolicy.APPEND_OR_REPLACE, request,
        )
        statusText.text = "Очередь поставлена на отправку."
    }

    private fun currentConfig(): ReaderConfig? {
        val config = ReaderConfig(
            baseUrl = baseUrlInput.text.toString().trim().trimEnd('/'),
            deviceId = deviceIdInput.text.toString().trim(),
            token = tokenInput.text.toString().trim(),
        )
        if (!config.baseUrl.startsWith("https://") || config.deviceId.isBlank() || config.token.isBlank()) {
            statusText.text = "Сначала заполни адрес сервера, ID телефона и токен."
            return null
        }
        return config
    }

    private fun updateListenerStatus() {
        val enabledListeners = Settings.Secure.getString(contentResolver, "enabled_notification_listeners").orEmpty()
        val enabled = enabledListeners.contains(packageName)
        statusText.text = if (enabled) {
            "Доступ к уведомлениям включён. На тестовом push Optima проверь входящий запрос в логах Render."
        } else {
            "Доступ к уведомлениям ещё не включён. Нажми кнопку 2 и разреши Flash Payment Reader."
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }
}
