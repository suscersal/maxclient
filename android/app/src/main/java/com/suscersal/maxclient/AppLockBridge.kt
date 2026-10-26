package com.suscersal.maxclient

import android.app.Activity
import android.content.Intent
import android.webkit.JavascriptInterface

/** Мост JS -> нативные настройки «Код-пароль» (пункт добавляется в меню настроек Web K скриптом из AppLockInjector). */
class AndroidAppLockBridge(private val activity: Activity) {
    @JavascriptInterface
    fun isEnabled(): Boolean = AppLock.isEnabled(activity)

    @JavascriptInterface
    fun lockNow() {
        activity.runOnUiThread { (activity as? MainActivity)?.lockNowFromWeb() }
    }

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
  // Кнопка-замочек в шапке списка чатов (как в Telegram): нажатие блокирует приложение сразу.
  var LOCK_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
  function syncLockBtn(){
    var on = false;
    try { on = !!window.AndroidAppLock.isEnabled(); } catch (e) {}
    var headers = document.querySelectorAll('.sidebar-header');
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      if (!h.querySelector('.input-search, .sidebar-header-search-trigger, input')) continue;
      var btn = h.querySelector('[data-mx-lockbtn]');
      if (on && !btn) {
        btn = document.createElement('button');
        btn.className = 'btn-icon sidebar-lock-button';
        btn.setAttribute('data-mx-lockbtn', '1');
        btn.setAttribute('aria-label', 'Заблокировать');
        btn.innerHTML = '<span class="sidebar-lock-button-icon">' + LOCK_SVG + '</span>';
        btn.addEventListener('click', function(e){ e.stopPropagation(); e.preventDefault(); window.AndroidAppLock.lockNow(); }, true);
        h.appendChild(btn);
        h.classList.remove('is-input-the-last-child');
      } else if (!on && btn) {
        btn.remove();
      }
    }
  }
  window.__mxLockSync = syncLockBtn;
  new MutationObserver(function(){ inject(); syncLockBtn(); }).observe(document.body, {childList: true, subtree: true});
  inject();
  syncLockBtn();
})();
"""
}
