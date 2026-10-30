/* mx-ui.js — нативные экраны MAX для интерфейса /tg/ (вместо фрейма со старым интерфейсом).
   Оформление — как в Komet: hero-фото профиля, скруглённые карточки, строки с иконками, переключатели.
   Цвета берутся из CSS-переменных Web K (--surface-color и т.д.), поэтому следуют выбранной теме.
   Данные профиля приходят из воркера по BroadcastChannel "mx-ui" (см. ext6 в index.worker-*.js),
   остальное — из REST-ручек bridge (/api/...). Точка входа: window.__mxOpen(id, title). */
(function () {
  'use strict';
  if (window.__mxUi) return;

  /* ------------------------------------------------------------ утилиты */
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtBytes(b) {
    if (!b) return '0 КБ';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' ГБ';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' МБ';
    return Math.max(1, Math.round(b / 1024)) + ' КБ';
  }
  function fmtDT(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(ms); }
  }
  function imgUrl(u) { return u ? '/img?url=' + encodeURIComponent(u) : ''; }
  function hashColor(s) {
    var n = 0, i;
    for (i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    var hue = n % 360;
    return 'linear-gradient(160deg,hsl(' + hue + ',55%,42%),hsl(' + ((hue + 40) % 360) + ',60%,28%))';
  }
  function jget(url, opt) {
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok && !(j && (j.ok || j.success))) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; });
    });
  }
  function jpost(url, body) { return jget(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }

  /* ------------------------------------------------------------ иконки */
  var P = {
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    chat: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/>',
    bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.6 2H4.4z"/><path d="M10 21h4"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    userplus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>',
    idcard: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.6-1.6 1.8-2.3 3-2.3s2.4.7 3 2.3M14.5 10h4M14.5 13.5h3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    minus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6A17 17 0 0 0 2 12s3.6 6 10 6a9.7 9.7 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    db: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
    device: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
    bug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 7V4M8 12H4M16 12h4M8 17l-3 2M16 17l3 2M9 5l-1.5-1.5M15 5l1.5-1.5"/>',
    share: '<circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="6" r="2.5"/><circle cx="17" cy="18" r="2.5"/><path d="M8.2 10.8l6.6-3.6M8.2 13.2l6.6 3.6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
    gift: '<rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M3 9h18v3H3zM12 9v11M12 9c-2.5 0-4.5-.6-4.5-2.4S9 4.2 12 9zM12 9c2.5 0 4.5-.6 4.5-2.4S15 4.2 12 9z"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5M8.5 13.5h.01M15.5 13.5h.01M9 16.5h6"/><circle cx="12" cy="4" r="1"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.500 18.400 12 21c-2.500-2.600-3.800-5.600-3.800-9S9.500 5.600 12 3z"/>',
    mute: '<path d="M6 16v-5a6 6 0 0 1 9-5.2M18 11v5l1.6 2H5M10 21h4M3 3l18 18"/>',
    classic: '<rect x="3" y="4" width="18" height="14" rx="2.5"/><path d="M8 21h8M12 18v3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'
  };
  function icon(n, size) {
    var s = size || 24;
    return h('span', { class: 'mxu-ic', html: '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (P[n] || '') + '</svg>' });
  }

  /* ------------------------------------------------------------ стили */
  var CSS = [
    '.mxu-root{position:fixed;inset:0;z-index:2147483000;background:var(--background-color,#0b0b0d);color:var(--primary-text-color,#fff);overflow:hidden;-webkit-tap-highlight-color:transparent;line-height:1.3}',
    '.mxu-root *{box-sizing:border-box}',
    '.mxu-page{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;background:var(--background-color,#0b0b0d);padding-bottom:calc(36px + env(safe-area-inset-bottom,0px));transform:translateX(100%);transition:transform .26s cubic-bezier(.4,0,.2,1);overscroll-behavior:contain}',
    '.mxu-page.mxu-in{transform:none}',
    '.mxu-bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:6px;padding:calc(8px + env(safe-area-inset-top,0px)) 10px 8px;background:var(--background-color,#0b0b0d)}',
    '.mxu-bar h1{margin:0;font-size:21px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mxu-ib{width:44px;height:44px;border:0;border-radius:50%;background:transparent;color:inherit;display:grid;place-items:center;cursor:pointer;flex:none}',
    '.mxu-ib:active{background:rgba(128,128,128,.2)}',
    '.mxu-ic{display:inline-flex;flex:none}',
    '.mxu-hero{position:relative;height:min(56vh,480px);min-height:320px;overflow:hidden;background:#1c1c1e}',
    '.mxu-hero>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.mxu-hero-ph{position:absolute;inset:0;display:grid;place-items:center;font-size:120px;font-weight:700;color:rgba(255,255,255,.85)}',
    '.mxu-hero:after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(to bottom,rgba(0,0,0,.38) 0,rgba(0,0,0,0) 26%,rgba(0,0,0,0) 48%,var(--mxu-fade,rgba(0,0,0,.82)) 100%)}',
    '.mxu-hero-top{position:absolute;left:0;right:0;top:0;z-index:2;display:flex;justify-content:space-between;padding:calc(14px + env(safe-area-inset-top,0px)) 14px 0}',
    '.mxu-fab{width:46px;height:46px;border:0;border-radius:50%;background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#fff;display:grid;place-items:center;cursor:pointer}',
    '.mxu-fab:active{background:rgba(0,0,0,.6)}',
    '.mxu-hero-meta{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:0 24px 16px;color:#fff}',
    '.mxu-name{font-size:34px;line-height:1.08;font-weight:700;text-shadow:0 1px 14px rgba(0,0,0,.55);word-break:break-word}',
    '.mxu-sub{margin-top:8px;font-size:18px;color:rgba(255,255,255,.78);display:flex;align-items:center;gap:8px;text-shadow:0 1px 8px rgba(0,0,0,.5);min-height:24px}',
    '.mxu-dot{width:12px;height:12px;border-radius:50%;background:var(--green-color,#4fcf6e);flex:none}',
    '.mxu-sub .mxu-eye{margin-left:4px;border:0;background:none;color:inherit;cursor:pointer;display:inline-flex;padding:2px}',
    '.mxu-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:2px 16px 10px}',
    '.mxu-tile{border:0;border-radius:22px;background:var(--surface-color,#17171a);color:inherit;padding:16px 6px 13px;display:flex;flex-direction:column;align-items:center;gap:8px;font:inherit;font-size:16px;cursor:pointer}',
    '.mxu-tile:active{filter:brightness(1.25)}',
    '.mxu-wide{display:flex;align-items:center;justify-content:center;gap:12px;margin:0 16px 10px;width:calc(100% - 32px);border:0;border-radius:22px;background:var(--surface-color,#17171a);color:inherit;padding:18px;font:inherit;font-size:19px;font-weight:500;cursor:pointer}',
    '.mxu-chips{display:flex;gap:10px;overflow-x:auto;padding:6px 16px 12px;scrollbar-width:none}',
    '.mxu-chips::-webkit-scrollbar{display:none}',
    '.mxu-chip{flex:none;border:0;border-radius:999px;background:var(--surface-color,#17171a);color:inherit;font:inherit;font-size:18px;padding:14px 22px;cursor:pointer}',
    '.mxu-chip.on{background:rgba(128,128,128,.34);font-weight:600}',
    '.mxu-card{margin:0 16px 14px;border-radius:26px;background:var(--surface-color,#17171a);overflow:hidden}',
    '.mxu-sec{margin:20px 28px 8px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--secondary-text-color,#8e8e93)}',
    '.mxu-hint{margin:6px 28px 16px;font-size:13.5px;line-height:1.45;color:var(--secondary-text-color,#8e8e93)}',
    '.mxu-row{display:flex;align-items:center;gap:16px;padding:17px 20px;min-height:62px;position:relative;cursor:default}',
    '.mxu-row.click{cursor:pointer}',
    '.mxu-row.click:active{background:rgba(128,128,128,.14)}',
    '.mxu-row+.mxu-row:before{content:"";position:absolute;left:20px;right:0;top:0;height:1px;background:var(--border-color,rgba(128,128,128,.22))}',
    '.mxu-row.ic+.mxu-row.ic:before{left:60px}',
    '.mxu-row .mxu-ic{color:var(--secondary-text-color,#9a9aa0)}',
    '.mxu-grow{flex:1;min-width:0}',
    '.mxu-t{font-size:18px;font-weight:500;word-break:break-word}',
    '.mxu-s{margin-top:2px;font-size:13.5px;color:var(--secondary-text-color,#8e8e93);word-break:break-word}',
    '.mxu-v{font-size:14px;color:var(--secondary-text-color,#8e8e93);text-align:right;max-width:46%;word-break:break-word}',
    '.mxu-row.danger .mxu-t{color:var(--danger-color,#ff5a52)}',
    '.mxu-info{flex-direction:row}',
    '.mxu-info .mxu-l{font-size:14px;color:var(--secondary-text-color,#8e8e93)}',
    '.mxu-info .mxu-val{margin-top:3px;font-size:19px;font-weight:500;word-break:break-all}',
    '.mxu-extra{display:none}',
    '.mxu-extra.open{display:block}',
    '.mxu-sw{width:52px;height:32px;border-radius:16px;background:rgba(128,128,128,.4);position:relative;flex:none;cursor:pointer;transition:background .18s}',
    '.mxu-sw:after{content:"";position:absolute;left:3px;top:3px;width:26px;height:26px;border-radius:50%;background:#fff;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.4)}',
    '.mxu-sw.on{background:var(--primary-color,#8774e1)}',
    '.mxu-sw.on:after{transform:translateX(20px)}',
    '.mxu-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;border:0;border-radius:16px;background:var(--primary-color,#8774e1);color:#fff;font:inherit;font-size:17px;font-weight:600;padding:14px 22px;cursor:pointer}',
    '.mxu-btn.ghost{background:rgba(128,128,128,.22);color:inherit}',
    '.mxu-btn.danger{background:rgba(255,90,82,.16);color:var(--danger-color,#ff5a52)}',
    '.mxu-btn[disabled]{opacity:.45;pointer-events:none}',
    '.mxu-btns{display:flex;flex-wrap:wrap;gap:10px;margin:0 16px 14px}',
    '.mxu-field{display:block;padding:12px 20px 14px;position:relative}',
    '.mxu-field+.mxu-field:before{content:"";position:absolute;left:20px;right:0;top:0;height:1px;background:var(--border-color,rgba(128,128,128,.22))}',
    '.mxu-field span{display:block;font-size:13px;color:var(--secondary-text-color,#8e8e93);margin-bottom:5px}',
    '.mxu-field input,.mxu-field select{width:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:17px;padding:2px 0}',
    '.mxu-field select option{color:#000}',
    '.mxu-radio{width:24px;height:24px;border-radius:50%;border:2px solid rgba(128,128,128,.6);flex:none;display:grid;place-items:center}',
    '.mxu-row.sel .mxu-radio{border-color:var(--primary-color,#8774e1);background:var(--primary-color,#8774e1);color:#fff}',
    '.mxu-row.sel .mxu-radio:after{content:"";width:8px;height:8px;border-radius:50%;background:#fff}',
    '.mxu-bar-prog{height:6px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden;margin:6px 20px 14px}',
    '.mxu-bar-prog i{display:block;height:100%;background:var(--green-color,#4fcf6e);width:0;transition:width .3s}',
    '.mxu-center{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 20px 14px;text-align:center}',
    '.mxu-logo{width:84px;height:84px;border-radius:24px;background:linear-gradient(135deg,var(--primary-color,#8774e1),#4ea4f6);display:grid;place-items:center;color:#fff;font-size:40px;font-weight:700}',
    '.mxu-spin{width:30px;height:30px;border-radius:50%;border:3px solid rgba(128,128,128,.3);border-top-color:var(--primary-color,#8774e1);animation:mxu-r .8s linear infinite;margin:60px auto}',
    '@keyframes mxu-r{to{transform:rotate(360deg)}}',
    '.mxu-toast{position:fixed;left:50%;bottom:calc(36px + env(safe-area-inset-bottom,0px));transform:translate(-50%,20px);opacity:0;background:rgba(40,40,44,.96);color:#fff;border-radius:14px;padding:12px 18px;font-size:15px;z-index:2147483100;transition:.2s;max-width:86vw;text-align:center}',
    '.mxu-toast.on{opacity:1;transform:translate(-50%,0)}',
    '.mxu-err{margin:30px 28px;text-align:center;color:var(--secondary-text-color,#8e8e93);font-size:15px}',
    '.mxu-gif{display:block;max-width:calc(100% - 32px);max-height:60vh;margin:10px auto;border-radius:20px}'
  ].join('\n');
  var st = document.createElement('style'); st.id = 'mxu-css'; st.textContent = CSS; document.head.appendChild(st);

  /* ------------------------------------------------------------ RPC к воркеру */
  var bc = null, pend = {}, seq = 0;
  try {
    bc = new BroadcastChannel('mx-ui');
    bc.onmessage = function (e) {
      var d = e.data; if (!d || d.t !== 'res') return;
      var p = pend[d.id]; if (!p) return;
      delete pend[d.id]; clearTimeout(p.t);
      if (d.e) p.rej(new Error(d.e)); else p.res(d.r);
    };
  } catch (e) { bc = null; }
  function rpc(m, a, ms) {
    return new Promise(function (res, rej) {
      if (!bc) return rej(new Error('BroadcastChannel недоступен'));
      var id = (++seq) + '-' + Date.now();
      pend[id] = { res: res, rej: rej, t: setTimeout(function () { delete pend[id]; rej(new Error('воркер не ответил (подождите, пока загрузятся чаты)')); }, ms || 12000) };
      bc.postMessage({ t: 'req', id: id, m: m, a: a || {} });
    });
  }

  /* ------------------------------------------------------------ каркас страниц */
  /* Системная «Назад» (Android-жест/кнопка, кнопка браузера) закрывает верхний экран, а не выходит из приложения.
     Пока открыт хоть один слой, в истории лежит одна «страховочная» запись; popstate снимает верхний слой.
     Слоями могут быть и чужие оверлеи (фрейм классического UI): window.__mxBackLayer(close) → release(). */
  var root = null, pages = [], layers = [], sent = false, skipPop = null;
  function syncSent(cb) {
    if (layers.length && !sent) { try { history.pushState({ mxu: 1 }, ''); sent = true; } catch (e) { } if (cb) cb(); }
    else if (!layers.length && sent) { sent = false; skipPop = cb || true; try { history.back(); } catch (e) { skipPop = null; if (cb) cb(); } }
    else if (cb) cb();
  }
  function layerPush(close, isPage) { var L = { close: close, page: !!isPage }; layers.push(L); syncSent(); return L; }
  function layerRelease(L) { var i = layers.indexOf(L); if (i >= 0) layers.splice(i, 1); syncSent(); }
  window.addEventListener('popstate', function (e) {
    if (skipPop !== null) { var f = skipPop; skipPop = null; e.stopImmediatePropagation(); if (typeof f === 'function') f(); return; }
    if (!sent) return;
    e.stopImmediatePropagation(); sent = false;           // запись-страховку браузер уже снял
    var L = layers.pop(); if (L) { try { L.close(); } catch (er) { } }
    syncSent();                                           // остались слои — вернём запись
  }, true);
  function ensureRoot() {
    if (root) return root;
    root = h('div', { class: 'mxu-root' });
    document.body.appendChild(root);
    updateTheme();
    document.addEventListener('keydown', onKey, true);
    return root;
  }
  function updateTheme() {
    if (!root) return;
    var bg = getComputedStyle(root).backgroundColor, m = bg.match(/\d+(\.\d+)?/g) || [11, 11, 13];
    var lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
    root.style.setProperty('--mxu-fade', lum < 0.5 ? bg : 'rgba(0,0,0,.78)');
  }
  function dropRoot() { if (root) { root.remove(); root = null; document.removeEventListener('keydown', onKey, true); } }
  function onKey(e) { if (e.key === 'Escape' && layers.length) { e.stopPropagation(); back(); } }
  function removePage(pg) {
    var i = pages.indexOf(pg); if (i >= 0) pages.splice(i, 1);
    pg.el.classList.remove('mxu-in');
    setTimeout(function () { pg.el.remove(); if (!pages.length) dropRoot(); }, 270);
  }
  /* кнопка «назад» в интерфейсе = то же, что системная */
  function back() {
    var L = layers[layers.length - 1]; if (!L) return;
    if (sent) { try { history.back(); return; } catch (e) { } }
    layers.pop(); L.close(); syncSent();
  }
  /* закрыть все экраны MAX (например, перед переходом в чат); cb вызовется, когда история приведена в порядок */
  function closeAll(cb) {
    var ps = pages.slice(); pages.length = 0; ps.forEach(function (p) { p.el.remove(); });
    layers = layers.filter(function (l) { return !l.page; });
    dropRoot();
    syncSent(cb);
  }
  function page(opts) {
    ensureRoot();
    var el = h('div', { class: 'mxu-page' }), body = h('div', { class: 'mxu-body' });
    var title = h('h1', null, opts.title || '');
    if (!opts.hero) el.appendChild(h('div', { class: 'mxu-bar' }, h('button', { class: 'mxu-ib', 'aria-label': 'Назад', onclick: back }, icon('back')), title, opts.right || null));
    el.appendChild(body);
    root.appendChild(el);
    var pg = { el: el, body: body, title: title, setTitle: function (t) { title.textContent = t; }, spin: function () { body.innerHTML = ''; body.appendChild(h('div', { class: 'mxu-spin' })); } };
    pages.push(pg);
    layerPush(function () { removePage(pg); }, true);
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('mxu-in'); }); });
    return pg;
  }
  var toastEl = null, toastT = 0;
  function toast(msg) {
    if (!toastEl) { toastEl = h('div', { class: 'mxu-toast' }); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 2200);
  }
  function copy(text, what) {
    function done() { toast((what || 'Значение') + ' скопировано'); }
    try { navigator.clipboard.writeText(String(text)).then(done, fallback); } catch (e) { fallback(); }
    function fallback() {
      var t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = String(text); document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Не удалось скопировать'); } t.remove();
    }
  }
  function errBox(e) { return h('div', { class: 'mxu-err' }, '⚠️ ' + (e && e.message || e)); }

  /* ------------------------------------------------------------ компоненты */
  function card() { var c = h('div', { class: 'mxu-card' }); add(c, [].slice.call(arguments)); return c; }
  function sec(t) { return h('div', { class: 'mxu-sec' }, t); }
  function hint(t) { return h('div', { class: 'mxu-hint' }, t); }
  function row(o) {
    var r = h('div', { class: 'mxu-row' + (o.icon ? ' ic' : '') + (o.onclick ? ' click' : '') + (o.danger ? ' danger' : '') + (o.sel ? ' sel' : ''), onclick: o.onclick || null });
    if (o.icon) r.appendChild(icon(o.icon));
    if (o.radio) r.appendChild(h('span', { class: 'mxu-radio' }));
    r.appendChild(h('div', { class: 'mxu-grow' }, h('div', { class: 't mxu-t' }, o.title), o.sub ? h('div', { class: 'mxu-s' }, o.sub) : null));
    if (o.value != null) r.appendChild(h('div', { class: 'mxu-v' }, o.value));
    if (o.toggle) r.appendChild(sw(o.toggle.on, o.toggle.onchange));
    if (o.chev) r.appendChild(icon('chev', 20));
    return r;
  }
  function sw(on, cb) {
    var s = h('div', { class: 'mxu-sw' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false' });
    s.addEventListener('click', function (e) {
      e.stopPropagation(); var v = !s.classList.contains('on');
      s.classList.toggle('on', v); s.setAttribute('aria-checked', v ? 'true' : 'false'); if (cb) cb(v);
    });
    return s;
  }
  function infoRow(label, value, o) {
    o = o || {};
    var r = h('div', { class: 'mxu-row mxu-info' + (o.copy ? ' click' : ''), onclick: o.copy ? function () { copy(value, label); } : null },
      h('div', { class: 'mxu-grow' }, h('div', { class: 'mxu-l' }, label), h('div', { class: 'mxu-val' }, value)));
    if (o.copy) r.appendChild(h('span', { style: 'color:var(--secondary-text-color,#8e8e93)' }, icon('copy', 22)));
    return r;
  }
  function field(label, input) { return h('label', { class: 'mxu-field' }, h('span', null, label), input); }
  function btn(text, cls, cb, ic) { return h('button', { class: 'mxu-btn' + (cls ? ' ' + cls : ''), onclick: cb }, ic ? icon(ic, 20) : null, text); }

  function hero(o) {
    var w = h('div', { class: 'mxu-hero' });
    var ph = h('div', { class: 'mxu-hero-ph', style: 'background:' + hashColor(o.title || '?') }, (o.title || '?').trim().charAt(0).toUpperCase());
    w.appendChild(ph);
    if (o.photo) {
      var img = h('img', { alt: '', src: imgUrl(o.photo) });
      img.onerror = function () {
        if (o.photoSmall && img.dataset.fb !== '1') { img.dataset.fb = '1'; img.src = imgUrl(o.photoSmall); } else img.remove();
      };
      w.appendChild(img);
    }
    var top = h('div', { class: 'mxu-hero-top' }, h('button', { class: 'mxu-fab', 'aria-label': 'Назад', onclick: back }, icon('back')), h('div', null, o.right || null));
    var sub = h('div', { class: 'mxu-sub' });
    if (o.dot) sub.appendChild(h('span', { class: 'mxu-dot' }));
    if (o.subText) sub.appendChild(h('span', null, o.subText));
    var meta = h('div', { class: 'mxu-hero-meta' }, h('div', { class: 'mxu-name' }, o.title || ''), sub);
    w.appendChild(top); w.appendChild(meta);
    w.sub = sub;
    return w;
  }

  /* ------------------------------------------------------------ профиль: общие куски */
  function presenceText(p) {
    if (!p) return '';
    if (p.k === 'online') return { text: 'онлайн', dot: true };
    if (p.k === 'offline' && p.t) {
      var d = new Date(p.t), now = new Date(), same = d.toDateString() === now.toDateString();
      return { text: 'был(-а) ' + (same ? 'в ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })) };
    }
    return { text: 'был(-а) недавно' };
  }
  function maskPhone(ph) {
    var d = String(ph || '').replace(/\D/g, ''); if (!d) return '';
    return '+' + d.slice(0, d.length > 10 ? d.length - 10 : 1) + ' ••• ••• ••-' + d.slice(-2);
  }
  function fullPhone(ph) { var d = String(ph || '').replace(/\D/g, ''); return d ? '+' + d : ''; }
  function statusLabel(s) { return s === 0 || s == null ? 'ACTIVE' : String(s); }
  function genderLabel(g) { return g === 1 ? 'мужской' : g === 2 ? 'женский' : ''; }

  /* Карточка Info: ID чата / ID пользователя / Создан / Статус (как в Komet), «⊕» раскрывает доп. поля контакта */
  function infoCard(p) {
    var extras = [];
    if (p.registrationTime) extras.push(['Дата регистрации', fmtDT(p.registrationTime)]);
    if (p.updateTime) extras.push(['Обновлён', fmtDT(p.updateTime)]);
    if (p.country) extras.push(['Страна', p.country]);
    if (genderLabel(p.gender)) extras.push(['Пол', genderLabel(p.gender)]);
    if (p.phone && !p.self) extras.push(['Телефон', fullPhone(p.phone)]);
    if (p.accountStatus) extras.push(['Статус аккаунта', String(p.accountStatus)]);
    if (p.options && p.options.length) extras.push(['Флаги', p.options.join(', ')]);
    if (p.link) extras.push(['Ссылка', p.link]);
    var c = card();
    if (p.chatId != null) {
      var first = infoRow('ID чата', String(p.chatId), { copy: true });
      if (extras.length) {
        var ex = h('div', { class: 'mxu-extra' }), tog = h('button', { class: 'mxu-ib', 'aria-label': 'Дополнительно', style: 'margin:-8px -10px -8px 0;color:var(--secondary-text-color,#8e8e93)' }, icon('plus', 26));
        extras.forEach(function (x) { ex.appendChild(infoRow(x[0], x[1], { copy: true })); });
        tog.addEventListener('click', function (e) {
          e.stopPropagation(); var o = ex.classList.toggle('open');
          tog.innerHTML = ''; tog.appendChild(icon(o ? 'minus' : 'plus', 26));
        });
        first.querySelector('span').replaceWith(tog);
        c.appendChild(first); c.appendChild(infoRow('ID пользователя', String(p.id), { copy: true }));
        if (p.chatCreated) c.appendChild(infoRow('Создан', fmtDT(p.chatCreated), { copy: true }));
        c.appendChild(infoRow('Статус', p.chatStatus || statusLabel(p.accountStatus), {}));
        c.appendChild(ex);
        return c;
      }
      c.appendChild(first);
    }
    c.appendChild(infoRow('ID пользователя', String(p.id), { copy: true }));
    if (p.registrationTime) c.appendChild(infoRow('Создан', fmtDT(p.registrationTime), { copy: true }));
    else if (p.chatCreated) c.appendChild(infoRow('Создан', fmtDT(p.chatCreated), { copy: true }));
    c.appendChild(infoRow('Статус', p.chatStatus || statusLabel(p.accountStatus), {}));
    if (p.country) c.appendChild(infoRow('Страна', p.country, { copy: true }));
    if (p.link) c.appendChild(infoRow('Ссылка', p.link, { copy: true }));
    return c;
  }

  /* ------------------------------------------------------------ экраны */
  var S = {};

  /* Мой профиль — hero + Info + все пункты MAX */
  S.profile = function () {
    var pg = page({ hero: true });
    pg.spin();
    rpc('me').then(function (p) {
      pg.body.innerHTML = '';
      var title = p.name || 'Профиль';
      var h0 = hero({ title: title, photo: p.photo, photoSmall: p.photoSmall, dot: true, subText: 'онлайн' });
      if (p.phone) {
        var shown = false, ph = h('span', null, maskPhone(p.phone));
        var eye = h('button', { class: 'mxu-eye', 'aria-label': 'Показать номер' }, icon('eyeoff', 22));
        eye.addEventListener('click', function () { shown = !shown; ph.textContent = shown ? fullPhone(p.phone) : maskPhone(p.phone); eye.innerHTML = ''; eye.appendChild(icon(shown ? 'eye' : 'eyeoff', 22)); });
        var line = h('div', { class: 'mxu-sub', style: 'margin-top:4px;font-size:16px' }, ph, eye);
        h0.querySelector('.mxu-hero-meta').appendChild(line);
      }
      pg.body.appendChild(h0);
      pg.body.appendChild(sec('Аккаунт'));
      p.self = true; pg.body.appendChild(infoCard(p));
      if (p.desc) { pg.body.appendChild(sec('О себе')); pg.body.appendChild(card(h('div', { class: 'mxu-row' }, h('div', { class: 'mxu-grow' }, h('div', { class: 'mxu-t', style: 'font-weight:400;font-size:17px;white-space:pre-wrap' }, p.desc))))); }
      pg.body.appendChild(sec('MAX'));
      pg.body.appendChild(card(
        row({ icon: 'bell', title: 'Уведомления', sub: 'Push и тестовое уведомление', chev: 1, onclick: function () { open('notifications'); } }),
        row({ icon: 'db', title: 'Использование памяти', sub: 'Кэш картинок и файлов', chev: 1, onclick: function () { open('storage'); } }),
        row({ icon: 'device', title: 'Устройство (протокол)', sub: 'Как клиент представляется серверу MAX', chev: 1, onclick: function () { open('device'); } }),
        row({ icon: 'shield', title: 'Скам-проверка (ИИ)', sub: 'Проверка входящих сообщений', chev: 1, onclick: function () { open('scam'); } })
      ));
      pg.body.appendChild(card(
        row({ icon: 'gift', title: 'Пригласить друзей', chev: 1, onclick: function () { open('invite'); } }),
        row({ icon: 'link', title: 'Вступить по ссылке', chev: 1, onclick: function () { closeAll(function () { legacyOpen('joinLink', 'Вступить по ссылке'); }); } }),
        row({ icon: 'info', title: 'Дополнительно', chev: 1, onclick: function () { open('more'); } }),
        row({ icon: 'info', title: 'О приложении', chev: 1, onclick: function () { open('about'); } })
      ));
    }, function (e) { pg.body.innerHTML = ''; pg.body.appendChild(hero({ title: 'Профиль' })); pg.body.appendChild(errBox(e)); });
  };

  /* Профиль контакта / чата — hero + Чат + Info */
  S.contact = function (a) {
    a = a || {};
    var pg = page({ hero: true });
    pg.spin();
    rpc(a.group ? 'chat' : 'contact', { id: a.id }).then(function (p) {
      pg.body.innerHTML = '';
      var ps = a.group ? { text: p.members ? p.members + ' участн.' : '' } : presenceText(p.presence);
      var h0 = hero({ title: p.name || ('ID ' + a.id), photo: p.photo, photoSmall: p.photoSmall, dot: ps && ps.dot, subText: ps && ps.text });
      pg.body.appendChild(h0);
      var tiles = h('div', { class: 'mxu-tiles' });
      tiles.appendChild(h('button', { class: 'mxu-tile', onclick: function () { closeAll(function () { try { location.hash = '#' + (a.group ? -Math.abs(a.id) : a.id); } catch (e) { } }); } }, icon('chat', 28), 'Чат'));
      tiles.appendChild(h('button', { class: 'mxu-tile', onclick: function () { copy(p.id, 'ID'); } }, icon('copy', 28), 'ID'));
      tiles.appendChild(h('button', { class: 'mxu-tile', onclick: function () { if (p.link) copy(p.link, 'Ссылка'); else if (p.phone) copy(fullPhone(p.phone), 'Номер'); else toast('Нечего копировать'); } }, icon('link', 28), p.link ? 'Ссылка' : 'Номер'));
      pg.body.appendChild(tiles);
      pg.body.appendChild(sec('Info'));
      if (p.desc) pg.body.appendChild(card(h('div', { class: 'mxu-row' }, h('div', { class: 'mxu-grow' }, h('div', { class: 'mxu-l', style: 'font-size:14px;color:var(--secondary-text-color,#8e8e93)' }, 'О себе'), h('div', { class: 'mxu-t', style: 'font-weight:400;font-size:17px;margin-top:3px;white-space:pre-wrap' }, p.desc)))));
      pg.body.appendChild(infoCard(p));
    }, function (e) { pg.body.innerHTML = ''; pg.body.appendChild(hero({ title: 'Профиль' })); pg.body.appendChild(errBox(e)); });
  };

  S.invite = function () {
    var pg = page({ title: 'Пригласить друзей' });
    var url = 'https://github.com/suscersal/maxclient', text = 'Неофициальный клиент MAX — maxclient: ' + url;
    pg.body.appendChild(h('div', { class: 'mxu-center' }, h('div', { class: 'mxu-logo' }, icon('gift', 40)), h('div', { class: 't mxu-t', style: 'font-size:21px;margin-top:8px' }, 'Расскажите друзьям'), h('div', { class: 'mxu-s' }, 'Ссылка на репозиторий maxclient на GitHub')));
    pg.body.appendChild(card(row({ icon: 'link', title: url, onclick: function () { copy(url, 'Ссылка'); } })));
    pg.body.appendChild(h('div', { class: 'mxu-btns', style: 'justify-content:center' },
      btn('Поделиться', '', function () {
        if (navigator.share) navigator.share({ text: text, url: url }).catch(function () { });
        else copy(text, 'Ссылка');
      }, 'share'),
      btn('Скопировать', 'ghost', function () { copy(text, 'Ссылка'); }, 'copy')));
  };

  S.notifications = function () {
    var pg = page({ title: 'Уведомления' });
    function render() {
      pg.body.innerHTML = '';
      var supported = 'Notification' in window, perm = supported ? Notification.permission : 'unsupported';
      var label = perm === 'granted' ? 'Включены' : perm === 'denied' ? 'Заблокированы в браузере' : perm === 'unsupported' ? 'Недоступны в этом окружении' : 'Выключены';
      pg.body.appendChild(sec('Push-уведомления'));
      pg.body.appendChild(card(row({ icon: 'bell', title: 'Уведомления о сообщениях', sub: label })));
      var bs = h('div', { class: 'mxu-btns' });
      if (perm === 'default') bs.appendChild(btn('Включить push', '', enablePush, 'bell'));
      if (perm === 'granted') bs.appendChild(btn('Тестовое уведомление', 'ghost', function () { jpost('/api/push/test').then(function () { toast('Тестовое уведомление отправлено'); }, function (e) { toast('Ошибка: ' + e.message); }); }, 'bell'));
      pg.body.appendChild(bs);
      pg.body.appendChild(hint(perm === 'unsupported'
        ? 'В Android-приложении уведомления приходят через нативный push-канал — отдельно включать их здесь не нужно.'
        : perm === 'denied' ? 'Разрешите уведомления для этого сайта в настройках браузера и откройте экран снова.'
          : 'Работает без Firebase — стандартный Web Push через bridge.py. Нужен HTTPS и pip install pywebpush на сервере.'));
    }
    function enablePush() {
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') { render(); return toast('Разрешение не выдано'); }
        initWebPush().then(function () { toast('Push-уведомления включены'); render(); }, function (e) { toast('Push недоступен: ' + e.message); render(); });
      });
    }
    function initWebPush() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return Promise.reject(new Error('Web Push не поддерживается'));
      return navigator.serviceWorker.register('/sw.js').then(function (reg) {
        return reg.pushManager.getSubscription().then(function (ex) {
          if (ex) return ex;
          return jget('/api/push/vapid-public-key').then(function (k) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k.publicKey }); })
            .then(function (sub) { return jpost('/api/push/subscribe', sub.toJSON()).then(function () { return sub; }); });
        });
      });
    }
    render();
  };

  S.storage = function () {
    var pg = page({ title: 'Использование памяти' });
    function render() {
      pg.body.innerHTML = '';
      var estRow = row({ icon: 'db', title: 'Занято на устройстве', value: '…' });
      pg.body.appendChild(sec('Браузер'));
      pg.body.appendChild(card(estRow));
      if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) {
        estRow.querySelector('.mxu-v').textContent = fmtBytes(e.usage) + (e.quota ? ' из ' + fmtBytes(e.quota) : '');
      }).catch(function () { estRow.querySelector('.mxu-v').textContent = '—'; });
      var cc = card(); pg.body.appendChild(sec('Кэш файлов Web K')); pg.body.appendChild(cc);
      if (window.caches) caches.keys().then(function (names) {
        if (!names.length) cc.appendChild(row({ title: 'Кэш пуст' }));
        names.forEach(function (n) {
          var r = row({ icon: 'image', title: n, value: '…', onclick: function () { if (confirm('Очистить «' + n + '»? Файлы скачаются заново при необходимости.')) caches.delete(n).then(function () { toast('Очищено'); render(); }); } });
          cc.appendChild(r);
          caches.open(n).then(function (c) { return c.keys(); }).then(function (k) { r.querySelector('.mxu-v').textContent = k.length + ' шт.'; });
        });
      });
      pg.body.appendChild(hint('Нажмите на кэш, чтобы очистить его. Сами сообщения не удаляются — медиа скачается заново при открытии.'));
      pg.body.appendChild(sec('Кэш картинок bridge'));
      var br = row({ icon: 'db', title: 'Аватарки и стикеры на диске', value: '…' });
      pg.body.appendChild(card(br));
      jget('/api/img-cache').then(function (d) { br.querySelector('.mxu-v').textContent = fmtBytes(d.bytes) + ' · ' + d.files + ' шт.'; }, function () { br.querySelector('.mxu-v').textContent = 'недоступно'; });
      pg.body.appendChild(h('div', { class: 'mxu-btns' }, btn('Очистить кэш картинок', 'danger', function () {
        if (confirm('Очистить дисковый кэш картинок bridge?')) jpost('/api/img-cache/clear').then(function () { toast('Кэш картинок очищен'); render(); }, function (e) { toast('Ошибка: ' + e.message); });
      }, 'trash')));
      pg.body.appendChild(hint('Диск bridge хранит аватарки и превью, чтобы после перезапуска они не качались с серверов MAX заново (лимит 150 МБ).'));
    }
    render();
  };

  S.device = function () {
    var pg = page({ title: 'Устройство' });
    function render() {
      pg.spin();
      jget('/api/device-settings').then(function (d) {
        pg.body.innerHTML = '';
        pg.body.appendChild(hint('Эти данные передаются серверу MAX при подключении (какое устройство и версию системы «видит» сервер). Смена профиля или Device ID не требует новой авторизации; применится со следующего подключения.'));
        pg.body.appendChild(sec('Профиль устройства'));
        var c = card();
        Object.keys(d.profiles || {}).forEach(function (id) {
          var rw = row({ radio: 1, sel: d.profile === id, title: d.profiles[id], onclick: function () { jpost('/api/device-settings', { profile: id }).then(function () { toast('Профиль изменён'); render(); }, function (e) { toast('Ошибка: ' + e.message); }); } });
          c.appendChild(rw);
        });
        pg.body.appendChild(c);
        pg.body.appendChild(sec('Device ID'));
        pg.body.appendChild(card(infoRow('Идентификатор', d.deviceId || '—', { copy: !!d.deviceId })));
        pg.body.appendChild(h('div', { class: 'mxu-btns' }, btn('Пересоздать Device ID', 'danger', function () {
          jpost('/api/device-settings/regenerate').then(function () { toast('Device ID пересоздан'); render(); }, function (e) { toast('Ошибка: ' + e.message); });
        }, 'refresh')));
        pg.body.appendChild(sec('Каталог Google Play'));
        var inp = h('input', { type: 'text', placeholder: 'Модель: Redmi, Galaxy, Poco…' }), res = h('div');
        pg.body.appendChild(card(field(d.catalogCount > 0 ? 'В каталоге ' + d.catalogCount.toLocaleString('ru-RU') + ' устройств' : 'Каталог ещё скачивается — обновите через минуту', inp)));
        var rc = card(); rc.style.display = 'none'; pg.body.appendChild(rc);
        var tm = 0;
        inp.addEventListener('input', function () {
          clearTimeout(tm); tm = setTimeout(function () {
            var q = inp.value.trim(); rc.innerHTML = ''; if (q.length < 2) { rc.style.display = 'none'; return; }
            jget('/api/device-catalog?q=' + encodeURIComponent(q) + '&limit=30').then(function (r) {
              rc.style.display = ''; if (!r.matches.length) rc.appendChild(row({ title: 'Ничего не найдено' }));
              r.matches.forEach(function (name) { rc.appendChild(row({ title: name, onclick: function () { jpost('/api/device-settings', { customDeviceName: name }).then(function () { toast('Выбрано: ' + name); render(); }, function (e) { toast('Ошибка: ' + e.message); }); } })); });
            }, function () { });
          }, 250);
        });
        if (d.profile === 'custom' && d.customDeviceName) pg.body.appendChild(hint('Сейчас выбрано из каталога: ' + d.customDeviceName));
        pg.body.appendChild(h('div', { class: 'mxu-btns' }, btn('Обновить каталог', 'ghost', function () { jpost('/api/device-catalog/refresh').then(function () { toast('Обновление идёт в фоне, поиск заработает через 10–20 с'); }, function (e) { toast('Ошибка: ' + e.message); }); }, 'refresh')));
      }, function (e) { pg.body.innerHTML = ''; pg.body.appendChild(errBox(e)); });
    }
    render();
  };

  S.scam = function () {
    var pg = page({ title: 'Скам-проверка' });
    var timer = 0;
    function render() {
      clearTimeout(timer);
      Promise.all([jget('/api/scam-check/settings'), jget('/api/scam-check/models').catch(function () { return { models: [] }; }), jget('/api/scam-check/model-status').catch(function () { return {}; })]).then(function (r) {
        var cfg = r[0], models = r[1].models || [], ms = r[2];
        pg.body.innerHTML = '';
        pg.body.appendChild(hint('Проверка новых сообщений на скам и мошенничество ИИ-моделью. На Android модель работает прямо в приложении (скачивается один раз после включения) — текст сообщений никуда не отправляется.'));
        var enabled = !!cfg.enabled, model = cfg.onDeviceModelId, url = h('input', { type: 'text', value: cfg.url || '', placeholder: 'http://localhost:11434/v1/chat/completions' }), mdl = h('input', { type: 'text', value: cfg.model || '', placeholder: 'llama3.1' });
        pg.body.appendChild(card(row({ icon: 'shield', title: 'Включить проверку', toggle: { on: enabled, onchange: function (v) { enabled = v; save(); } } })));
        if (models.length) {
          pg.body.appendChild(sec('Модель на устройстве'));
          var mc = card();
          models.forEach(function (m) { mc.appendChild(row({ radio: 1, sel: m.id === (model || r[1].current), title: m.label, sub: m.downloaded ? 'скачана' : 'не скачана', onclick: function () { model = m.id; save(); } })); });
          pg.body.appendChild(mc);
        }
        var status = !ms.onDeviceSupported ? 'On-device модель недоступна (не Android-сборка) — используется внешний сервер ниже.'
          : ms.modelReady ? '✅ Модель на устройстве готова, проверка работает автоматически.'
            : ms.downloading ? ('⏳ Скачивание модели' + (ms.totalBytes ? ': ' + Math.round(ms.downloadedBytes / ms.totalBytes * 100) + '%' : '…'))
              : ms.error ? '❌ Ошибка загрузки: ' + ms.error : ms.llmInitError ? '❌ Не удалось запустить модель: ' + ms.llmInitError : 'Модель ещё не скачана.';
        pg.body.appendChild(hint(status));
        if (ms.downloading && ms.totalBytes) pg.body.appendChild(h('div', { class: 'mxu-bar-prog' }, h('i', { style: 'width:' + Math.round(ms.downloadedBytes / ms.totalBytes * 100) + '%' })));
        if (ms.onDeviceSupported) {
          var bs = h('div', { class: 'mxu-btns' });
          if (ms.modelReady) bs.appendChild(btn('Удалить модель', 'danger', function () { jget('/api/scam-check/model', { method: 'DELETE' }).then(function () { toast('Модель удалена'); render(); }); }, 'trash'));
          else if (!ms.downloading) bs.appendChild(btn('Скачать заново', 'ghost', function () { jpost('/api/scam-check/model/redownload').then(function () { toast('Загрузка запущена'); render(); }); }, 'refresh'));
          pg.body.appendChild(bs);
        }
        pg.body.appendChild(sec('Внешний сервер (для десктопа)'));
        pg.body.appendChild(card(field('Адрес API', url), field('Имя модели', mdl)));
        pg.body.appendChild(h('div', { class: 'mxu-btns' }, btn('Сохранить', '', function () { save(); }, 'check')));
        pg.body.appendChild(hint('Чтобы проверить конкретный чат — используйте классический интерфейс: профиль собеседника → «Проверить чат на скам».'));
        function save() {
          jpost('/api/scam-check/settings', { enabled: enabled, url: url.value.trim(), model: mdl.value.trim(), onDeviceModelId: model || undefined }).then(function () { toast('Сохранено'); render(); }, function (e) { toast('Ошибка: ' + e.message); });
        }
        if (ms.downloading) timer = setTimeout(render, 2000);
      }, function (e) { pg.body.innerHTML = ''; pg.body.appendChild(errBox(e)); });
    }
    pg.spin(); render();
    pg.el.addEventListener('mxu-gone', function () { clearTimeout(timer); });
  };

  S.about = function () {
    var pg = page({ title: 'О приложении' });
    var v = h('div', { class: 'mxu-s' }, 'Версия: загрузка…'), hf = h('div', { class: 'mxu-s' }, 'Hotfix: загрузка…');
    pg.body.appendChild(h('div', { class: 'mxu-center' }, h('div', { class: 'mxu-logo' }, 'M'), h('div', { class: 'mxu-t', style: 'font-size:22px;margin-top:8px' }, 'MAX Client'), v, hf));
    jget('/api/app-version').then(function (d) { v.textContent = d.versionCode != null ? 'Версия ' + d.versionName + ' (build ' + d.versionCode + ') — ' + (d.platform === 'android' ? 'Android' : 'десктоп') : 'Версия ' + d.versionName + ' — ' + (d.platform === 'android' ? 'Android' : 'десктоп'); }, function () { v.textContent = 'Версия: не удалось определить'; });
    jget('/api/hotfix-version').then(function (d) {
      var cur = d.current || 'не установлен';
      hf.textContent = !d.latest ? 'Hotfix: ' + cur + ' (последнюю версию проверить не удалось)' : d.upToDate ? 'Hotfix: ' + cur + ' ✅ актуальный' : 'Hotfix: ' + cur + ' → доступен ' + d.latest + ' ⚠️';
    }, function () { hf.textContent = 'Hotfix: не удалось определить'; });
    function ext(u) { return function () { window.open(u, '_blank', 'noopener'); }; }
    pg.body.appendChild(card(
      row({ icon: 'link', title: 'Репозиторий на GitHub', chev: 1, onclick: ext('https://github.com/suscersal/maxclient') }),
      row({ icon: 'refresh', title: 'Проверить обновления', sub: 'Releases на GitHub', chev: 1, onclick: ext('https://github.com/suscersal/maxclient/releases/latest') })
    ));
    var b = ''; try { b = localStorage.getItem('mx_tg_build') || ''; } catch (e) { }
    if (b) pg.body.appendChild(hint('Сборка интерфейса /tg/: ' + b));
  };

  S.gif = function () {
    var pg = page({ title: 'Просмотр GIF' });
    var img = h('img', { class: 'mxu-gif', alt: '', src: '/loading.gif' });
    var miss = h('div', { class: 'mxu-err', style: 'display:none' }, 'Файл /loading.gif не найден');
    img.onerror = function () { img.style.display = 'none'; miss.style.display = 'block'; };
    pg.body.appendChild(img); pg.body.appendChild(miss);
  };

  S.debug = function () {
    var pg = page({ title: 'Отладка' });
    function on() { try { return localStorage.getItem('mx_dbg_btn') !== '0'; } catch (e) { return true; } }
    pg.body.appendChild(card(
      row({ icon: 'bug', title: 'Кнопка отладочной консоли', sub: 'Журнал воркера, синхронизации и сетевых вызовов', toggle: { on: on(), onchange: function (v) { try { localStorage.setItem('mx_dbg_btn', v ? '1' : '0'); } catch (e) { } applyDbg(); } } }),
      row({ icon: 'bug', title: 'Открыть консоль', chev: 1, onclick: function () { var b = document.getElementById('debugConsoleToggle'); if (b) { closeAll(function () { b.click(); }); } else toast('Консоль недоступна'); } }),
      row({ icon: 'info', title: 'Журнал bridge (pylog)', sub: 'Последние строки логов сервера', chev: 1, onclick: function () { window.open('/api/debug/pylog', '_blank'); } })
    ));
    pg.body.appendChild(hint('Строки «sync: …», «stories: …», «deleted: …» и «e2e: …» в консоли показывают, где тратится время при старте и что происходит с историями и шифрованием.'));
  };

  S.more = function () {
    var pg = page({ title: 'Дополнительно' });
    pg.body.appendChild(card(
      row({ icon: 'image', title: 'Просмотр GIF', chev: 1, onclick: function () { open('gif'); } }),
      row({ icon: 'bug', title: 'Отладка', chev: 1, onclick: function () { open('debug'); } })
    ));
    pg.body.appendChild(sec('Только в классическом интерфейсе'));
    pg.body.appendChild(card(
      row({ icon: 'bot', title: 'Кастомные боты', sub: 'Чаты с локальными ботами живут в классическом чате', chev: 1, onclick: function () { legacyOpen('bots', 'Кастомные боты'); } }),
      row({ icon: 'classic', title: 'Переключиться на классический интерфейс', chev: 1, onclick: function () { legacyOpen('switchClassic', 'Классический интерфейс'); } })
    ));
  };

  /* ------------------------------------------------------------ вход */
  var legacy = window.__mxOpen;
  function legacyOpen(id, title) { if (typeof legacy === 'function') legacy(id, title); }
  function open(id, a) { var f = S[id]; if (f) f(a); }
  var ALIAS = { inviteFriends: 'invite', scamCheck: 'scam', gifPreview: 'gif', debugDump: 'debug', profile: 'profile', device: 'device', about: 'about' };
  window.__mxOpen = function (id, title) {
    var k = ALIAS[id] || id;
    if (S[k]) { open(k); return; }
    legacyOpen(id, title);
  };
  /* theme/vars правили CSS старого интерфейса и в /tg/ смысла не имеют (у Web K свои темы: Настройки → Настройки чатов) */
  S.theme = function () { toast('Тема меняется в Настройки → Настройки чатов'); };

  /* ------------------------------------------------------------ кнопка отладки: вкл/выкл */
  function applyDbg() {
    var s = document.getElementById('mxu-dbg'), hide = false;
    try { hide = localStorage.getItem('mx_dbg_btn') === '0'; } catch (e) { }
    if (!s) { s = document.createElement('style'); s.id = 'mxu-dbg'; document.head.appendChild(s); }
    s.textContent = hide ? '#debugConsoleToggle{display:none!important}' : '';
  }
  applyDbg();

  /* ------------------------------------------------------------ пункты в меню Web K */
  var GLYPH_USER = String.fromCharCode(0xea57);
  function currentPeer() {
    try {
      var im = window.appImManager, pid = im && im.chat && im.chat.peerId;
      if (pid != null && pid !== 0) return Number(pid);
    } catch (e) { }
    var m = /[#/](-?\d{3,})(?:$|[?_/])/.exec(location.hash || '');
    return m ? Number(m[1]) : null;
  }
  function cloneItem(proto, text, onclick) {
    var it = proto.cloneNode(true);
    it.setAttribute('data-mxu', '1');
    it.classList.remove('active', 'is-checked', 'hide');
    var tx = it.querySelector('.btn-menu-item-text'); if (tx) tx.textContent = text; else it.textContent = text;
    var ic = it.querySelector('.tgico, .btn-menu-item-icon'); if (ic) { ic.textContent = GLYPH_USER; }
    it.addEventListener('click', onclick);
    return it;
  }
  function txt(el) { var t = el.querySelector('.btn-menu-item-text'); return ((t || el).textContent || '').replace(/[\ue000-\uf8ff]/g, '').trim(); }
  function patchMenu(menu) {
    if (menu.hasAttribute('data-mxu-done')) return;
    var items = [].slice.call(menu.querySelectorAll('.btn-menu-item'));
    if (!items.length) return;
    var names = items.map(txt).join('|');
    if (/(^|\|)(Избранное|Saved Messages)(\||$)/.test(names)) {
      menu.setAttribute('data-mxu-done', '1');
      var fav = items.filter(function (el) { return /^(Избранное|Saved Messages)$/.test(txt(el)); })[0];
      fav.parentNode.insertBefore(cloneItem(fav, 'Профиль MAX', function () { open('profile'); }), fav);
    } else if (/(Выбрать сообщения|Select Messages|Очистить историю|Clear History|Удалить чат|Delete Chat|Покинуть|Leave|Заблокировать|Block)/i.test(names) && /(Поиск|Search)/i.test(names)) {
      menu.setAttribute('data-mxu-done', '1');
      var last = items[items.length - 1];
      last.parentNode.insertBefore(cloneItem(last, 'Info (MAX)', function () {
        var pid = currentPeer();
        if (pid == null) return toast('Не удалось определить чат');
        open('contact', pid < 0 ? { id: Math.abs(pid), group: true } : { id: pid });
      }), items[Math.max(0, items.length - 1)]);
    }
  }
  new MutationObserver(function () { document.querySelectorAll('.btn-menu').forEach(patchMenu); }).observe(document.documentElement, { childList: true, subtree: true });

  /* внешние оверлеи (фрейм классического UI) встают в тот же стек «Назад» */
  window.__mxBackLayer = function (close) { var L = layerPush(function () { close(); }, false); return function () { layerRelease(L); }; };
  window.__mxUi = { open: open, closeAll: closeAll, rpc: rpc, screens: S };
})();
