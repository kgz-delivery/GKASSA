package kg.flash.paymentreader

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class QueuedNotification(
    val hash: String,
    val packageName: String,
    val rawText: String,
    val receivedAt: String,
)

class NotificationStore(context: Context) : SQLiteOpenHelper(context, "reader_queue.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE notification_events (
                hash TEXT PRIMARY KEY NOT NULL,
                package_name TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                received_at TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )""".trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun enqueue(event: QueuedNotification): Boolean {
        val values = ContentValues().apply {
            put("hash", event.hash)
            put("package_name", event.packageName)
            put("raw_text", event.rawText)
            put("received_at", event.receivedAt)
            put("created_at", System.currentTimeMillis())
        }
        return writableDatabase.insertWithOnConflict(
            "notification_events", null, values, SQLiteDatabase.CONFLICT_IGNORE
        ) != -1L
    }

    fun pending(limit: Int = 30): List<QueuedNotification> {
        val events = mutableListOf<QueuedNotification>()
        readableDatabase.query(
            "notification_events",
            arrayOf("hash", "package_name", "raw_text", "received_at"),
            null, null, null, null, "created_at ASC", limit.toString(),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                events += QueuedNotification(
                    hash = cursor.getString(0),
                    packageName = cursor.getString(1),
                    rawText = cursor.getString(2),
                    receivedAt = cursor.getString(3),
                )
            }
        }
        return events
    }

    fun remove(hash: String) {
        writableDatabase.delete("notification_events", "hash = ?", arrayOf(hash))
    }
}
