package kg.flash.paymentreader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BankPushParserTest {
    private val template = BankTemplate(
        bankCode = "optima",
        packageName = "kz.optimabank.optima24",
        regexAmount = "На сумму:\\s*([0-9]+(?:[.,][0-9]{1,2})?)\\s*KGS",
        regexSender = "От:\\s*(.+?)\\s*$",
        isActive = true,
    )

    @Test
    fun parsesOptimaNotificationWithLineBreaks() {
        val text = "Пополнение по QR\nНа сумму: 100.00 KGS\nОт: Абдыманнапов Э. Э."
        val parsed = BankPushParser.parse(template, text)
        assertEquals("100.00", parsed?.amount)
        assertEquals("Абдыманнапов Э. Э.", parsed?.sender)
    }

    @Test
    fun parsesOptimaNotificationWithSmallAmount() {
        val text = "Пополнение по QR\nНа сумму: 10.00 KGS\nОт: Абдыманнапов Э. Э."
        assertEquals("10.00", BankPushParser.parse(template, text)?.amount)
    }

    @Test
    fun ignoresNotificationsWithoutAmountAndWrongBanks() {
        assertNull(BankPushParser.parse(template, "Баланс пополнен"))
        assertNull(BankPushParser.parse(template.copy(bankCode = "mbank"), "На сумму: 10.00 KGS"))
    }
}
