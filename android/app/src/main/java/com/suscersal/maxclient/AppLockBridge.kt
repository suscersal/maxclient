package com.suscersal.maxclient

import android.app.Activity
import android.content.Intent
import android.webkit.JavascriptInterface

/** Мост JS -> нативные настройки «Код-пароль» (пункт добавляется в меню настроек Web K скриптом из AppLockInjector). */
class AndroidAppLockBridge(private val activity: Activity) {
    @JavascriptInterface
    fun openSettings() {
        activity.runOnUiThread {
            activity.startActivity(Intent(activity, AppLockSettingsActivity::class.java))
        }
    }
}

object AppLockInjector {
    /** Скрипт ищет в настройках Web K строку «Конфиденциальность» и добавляет под ней «Код-пароль». */
    const val SCRIPT = """
(function(){
  if (window.__mxLockInj || !window.AndroidAppLock) return;
  window.__mxLockInj = 1;
  var rx = /конфиденциальн|privacy and security|privacy/i;
  function inject(){
    var titles = document.querySelectorAll('.row-title');
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (!rx.test(t.textContent || '')) continue;
      var row = t.closest('.row');
      if (!row || !row.parentNode) continue;
      if (row.parentNode.querySelector('[data-mx-lock]')) continue;
      var c = row.cloneNode(true);
      c.setAttribute('data-mx-lock', '1');
      var ct = c.querySelector('.row-title'); if (ct) ct.textContent = 'Код-пароль';
      var cs = c.querySelector('.row-subtitle'); if (cs) cs.textContent = 'Блокировка приложения кодом и отпечатком';
      c.addEventListener('click', function(e){ e.stopPropagation(); e.preventDefault(); window.AndroidAppLock.openSettings(); }, true);
      row.parentNode.insertBefore(c, row.nextSibling);
    }
  }
  new MutationObserver(inject).observe(document.body, {childList: true, subtree: true});
  inject();
})();
"""
}
