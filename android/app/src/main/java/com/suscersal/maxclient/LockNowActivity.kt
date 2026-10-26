package com.suscersal.maxclient

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Ярлык «Заблокировать» с иконки приложения: блокирует и открывает приложение (оно сразу покажет ввод кода). */
class LockNowActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLock.lockNow(this)
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        )
        finish()
    }
}
