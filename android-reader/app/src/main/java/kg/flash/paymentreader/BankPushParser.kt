package kg.flash.paymentreader

import java.math.BigDecimal
import java.math.RoundingMode

object BankPushParser {
    fun parse(template: BankTemplate, rawText: String): ParsedPayment? {
        if (!template.isActive || template.bankCode != "optima") return null
        val amountMatch = runCatching { Regex(template.regexAmount, RegexOption.IGNORE_CASE).find(rawText) }.getOrNull()
            ?: return null
        val rawAmount = amountMatch.groupValues.getOrNull(1)?.trim().orEmpty()
        if (rawAmount.isBlank()) return null
        val amount = runCatching {
            BigDecimal(rawAmount.replace(',', '.')).setScale(2, RoundingMode.UNNECESSARY).toPlainString()
        }.getOrNull() ?: return null

        val sender = template.regexSender
            ?.let { regex -> runCatching { Regex(regex, RegexOption.IGNORE_CASE).find(rawText) }.getOrNull() }
            ?.groupValues?.getOrNull(1)
            ?.trim()
            ?.takeIf(String::isNotBlank)
        return ParsedPayment(amount, sender)
    }
}
