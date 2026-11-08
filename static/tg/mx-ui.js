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
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8l1.6 2.3 2.7-.6.9 2.6 2.6.9-.6 2.7L21.5 12l-2.3 1.6.6 2.7-2.6.9-.9 2.6-2.7-.6L12 21.2l-1.6-2.3-2.7.6-.9-2.6-2.6-.9.6-2.7L2.5 12l2.3-1.6-.6-2.7 2.6-.9.9-2.6 2.7.6z"/>',
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
    '.mxu-gif{display:block;max-width:calc(100% - 32px);max-height:60vh;margin:10px auto;border-radius:20px}',
    '.mxu-tile.dim{opacity:.5}',
    '.mxu-tile.on{background:rgba(128,128,128,.3)}',
    '.mxu-wide .mxu-ic{color:var(--primary-color,#8774e1)}',
    '.mxu-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin:0 16px 14px;border-radius:22px;overflow:hidden}',
    '.mxu-gi{position:relative;aspect-ratio:1;background:rgba(128,128,128,.22);overflow:hidden;cursor:pointer}',
    '.mxu-gi img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.mxu-gi .mxu-play{position:absolute;right:6px;bottom:6px;width:26px;height:26px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;display:grid;place-items:center;font-size:11px}',
    '.mxu-ava{width:46px;height:46px;border-radius:50%;object-fit:cover;flex:none;display:grid;place-items:center;color:#fff;font-weight:700;font-size:19px;overflow:hidden}',
    '.mxu-ava img{width:100%;height:100%;object-fit:cover}',
    '.mxu-menu-bg{position:fixed;inset:0;z-index:2147483050}',
    '.mxu-menu{position:fixed;right:14px;top:calc(68px + env(safe-area-inset-top,0px));min-width:220px;border-radius:18px;background:var(--surface-color,#17171a);box-shadow:0 8px 30px rgba(0,0,0,.45);overflow:hidden;padding:6px 0;z-index:2147483051}',
    '.mxu-menu button{display:flex;align-items:center;gap:14px;width:100%;border:0;background:none;color:inherit;font:inherit;font-size:16px;padding:13px 18px;text-align:left;cursor:pointer}',
    '.mxu-menu button:active{background:rgba(128,128,128,.18)}',
    '.mxu-menu .mxu-ic{color:var(--secondary-text-color,#8e8e93)}',
    '.mxu-viewer{position:absolute;inset:0;background:#000;display:grid;place-items:center}',
    '.mxu-viewer img{max-width:100%;max-height:100%;object-fit:contain}',
    '.mxu-empty{padding:34px 24px;text-align:center;color:var(--secondary-text-color,#8e8e93);font-size:15px}',
    '@media (min-width:900px){.mxu-root{background:rgba(0,0,0,.6)}.mxu-page{width:560px;left:50%;right:auto;margin-left:-280px;box-shadow:0 0 40px rgba(0,0,0,.5)}}'
  ].join('\n');
  var st = document.createElement('style'); st.id = 'mxu-css'; st.textContent = CSS; document.head.appendChild(st);

  /* ------------------------------------------------------------ RPC к воркеру */
  var bc = null, pend = {}, seq = 0;
  /* APK: разрешаем обход X-Frame-Options/CSP frame-ancestors для хоста мини-приложения (MiniAppFrameFix.kt), иначе iframe покажет ERR_BLOCKED_BY_RESPONSE */
  function miniHost(url) {
    try { if (window.AndroidMiniApp && window.AndroidMiniApp.allowFrameHost) window.AndroidMiniApp.allowFrameHost(String(url)); } catch (e) { }
  }
  try {
    bc = new BroadcastChannel('mx-ui');
    bc.onmessage = function (e) {
      var d = e.data;
      if (d && d.t === 'webapp') { miniHost(d.url); return; }   /* воркер выдал адрес мини-приложения (requestWebView) */
      if (!d || d.t !== 'res') return;
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
  var root = null, pages = [], layers = [], sent = false, sentIdx = null, skipPop = null, foreign = 0;
  /* Web K сам вызывает history.back()/go(), когда закрывает меню, вкладку настроек или попап. Если такой вызов придётся
     на нашу запись-страховку, это не «Назад» пользователя. Системная «Назад» JS-вызовов не делает — так их и различаем. */
  var nativeBack = history.back, nativeGo = history.go;
  history.back = function () { foreign = Date.now(); return nativeBack.apply(history, arguments); };
  history.go = function () { foreign = Date.now(); return nativeGo.apply(history, arguments); };
  function ownBack() { return nativeBack.call(history); }
  function navIdx() { try { return window.navigation && navigation.currentEntry ? navigation.currentEntry.index : null; } catch (e) { return null; } }
  function syncSent(cb) {
    if (layers.length && !sent) { try { history.pushState({ mxu: 1 }, ''); sent = true; sentIdx = navIdx(); } catch (e) { } if (cb) cb(); }
    else if (!layers.length && sent) { sent = false; skipPop = cb || true; try { ownBack(); } catch (e) { skipPop = null; if (cb) cb(); } }
    else if (cb) cb();
  }
  function layerPush(close, isPage) { var L = { close: close, page: !!isPage }; layers.push(L); syncSent(); return L; }
  function layerRelease(L) { var i = layers.indexOf(L); if (i >= 0) layers.splice(i, 1); syncSent(); }
  window.addEventListener('popstate', function (e) {
    if (skipPop !== null) { var f = skipPop; skipPop = null; e.stopImmediatePropagation(); if (typeof f === 'function') f(); return; }
    if (!sent) return;
    var idx = navIdx();
    if (idx != null && sentIdx != null && idx >= sentIdx) return;      // не откат назад (чужой hash/pushState) — не наше событие
    if (foreign && Date.now() - foreign < 800) {                       // Web K сам сделал back и снял нашу запись: вернём её
      foreign = 0; sent = false; setTimeout(syncSent, 0); return;      // событие не глушим — Web K ждёт его для своих окон
    }
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
    if (sent) { try { ownBack(); return; } catch (e) { } }
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
        row({ icon: 'device', title: 'Устройства', sub: 'Сеансы аккаунта, выход на других', chev: 1, onclick: function () { open('sessions'); } }),
        row({ icon: 'info', title: 'Функции клиента', sub: 'Темы, призрак, автоответ, отладка', chev: 1, onclick: function () { open('features'); } }),
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

  /* Профиль контакта / чата — как в Komet: hero, плитки (Чат / Звук / Звонок), «Добавить в контакты», вкладки */
  function tile(ic, text, cb, cls) { return h('button', { class: 'mxu-tile' + (cls ? ' ' + cls : ''), onclick: cb }, icon(ic, 28), text); }
  function avatar(photo, title, size) {
    var el = h('div', { class: 'mxu-ava', style: 'background:' + hashColor(title || '?') + (size ? ';width:' + size + 'px;height:' + size + 'px' : '') }, (title || '?').trim().charAt(0).toUpperCase());
    if (photo) { var im = h('img', { alt: '', src: imgUrl(photo) }); im.onerror = function () { im.remove(); }; el.appendChild(im); }
    return el;
  }
  function showMenu(items) {
    ensureRoot();
    var bg = h('div', { class: 'mxu-menu-bg' }), m = h('div', { class: 'mxu-menu' }), L = null;
    function close() { if (L) { var x = L; L = null; layerRelease(x); } bg.remove(); m.remove(); }
    items.forEach(function (it) { m.appendChild(h('button', { onclick: function () { close(); it.run(); } }, icon(it.icon, 22), it.text)); });
    bg.addEventListener('click', close);
    root.appendChild(bg); root.appendChild(m);
    L = layerPush(function () { L = null; bg.remove(); m.remove(); }, false);   /* системная «Назад» закрывает меню, а не экран под ним */
  }
  function viewer(url, title) {
    var pg = page({ title: title || 'Фото' });
    pg.el.style.background = '#000'; pg.el.querySelector('.mxu-bar').style.background = '#000'; pg.el.querySelector('.mxu-bar').style.color = '#fff';
    pg.body.appendChild(h('div', { class: 'mxu-viewer', style: 'position:fixed;top:60px;left:0;right:0;bottom:0' }, h('img', { alt: '', src: imgUrl(url) })));
  }
  function goChat(a) { closeAll(function () { try { location.hash = '#' + (a.group ? -Math.abs(a.id) : a.id); } catch (e) { } }); }

  S.contact = function (a) {
    a = a || {};
    var pg = page({ hero: true });
    pg.spin();
    rpc(a.group ? 'chat' : 'contact', { id: a.id }).then(function (p) {
      pg.body.innerHTML = '';
      var ps = a.group ? { text: p.members ? p.members + ' участн.' : '' } : presenceText(p.presence);
      var items = [{ icon: 'copy', text: 'Копировать ID', run: function () { copy(p.id, 'ID'); } }];
      if (p.link) items.push({ icon: 'link', text: 'Копировать ссылку', run: function () { copy(p.link, 'Ссылка'); } });
      if (p.phone && !a.group) items.push({ icon: 'phone', text: 'Копировать номер', run: function () { copy(fullPhone(p.phone), 'Номер'); } });
      var more = h('button', { class: 'mxu-fab', 'aria-label': 'Меню', onclick: function () { showMenu(items); } }, icon('more'));
      pg.body.appendChild(hero({ title: p.name || ('ID ' + a.id), photo: p.photo, photoSmall: p.photoSmall, dot: ps && ps.dot, subText: ps && ps.text, right: more }));

      var tiles = h('div', { class: 'mxu-tiles' }), muted = !!p.muted;
      tiles.appendChild(tile('chat', 'Чат', function () { goChat(a); }));
      var snd;
      function mkSnd() { return tile(muted ? 'mute' : 'bell', muted ? 'Без звука' : 'Звук', toggleSound, muted ? 'on' : (p.canMute ? '' : 'dim')); }
      function toggleSound() {
        if (!p.canMute) return toast('Сначала откройте чат — диалога ещё нет');
        var want = !muted;
        rpc('mute', { id: a.id, group: !!a.group, mute: want }).then(function () {
          muted = want; var n = mkSnd(); snd.replaceWith(n); snd = n;
          toast(muted ? 'Уведомления выключены' : 'Уведомления включены');
        }, function (e) { toast('Ошибка: ' + e.message); });
      }
      snd = mkSnd();
      tiles.appendChild(snd);
      var canCall = !a.group && !p.bot && !p.self;
      tiles.appendChild(tile('phone', 'Звонок', function () {
        if (a.group) return toast('Групповые звонки не поддерживаются');
        if (p.bot || p.self) return toast('Этому контакту позвонить нельзя');
        var ph = p.photoSmall || p.photo;
        ensureCalls().then(function (M) {
          M.start(a.id, { name: p.name, avatarUrl: ph ? imgUrl(ph) : null });
        }, function (e) { toast('Звонки: ' + e.message); });
      }, canCall ? '' : 'dim'));
      pg.body.appendChild(tiles);

      if (!a.group && p.isContact === false && !p.bot && !p.self) {
        var addB = h('button', { class: 'mxu-wide', onclick: function () {
          rpc('addContact', { id: a.id }).then(function () { addB.remove(); toast('Контакт добавлен'); }, function (e) { toast('Ошибка: ' + e.message); });
        } }, icon('userplus', 26), 'Добавить в контакты');
        pg.body.appendChild(addB);
      }

      var tabs = a.group ? [['media', 'Медиа'], ['info', 'Info'], ['files', 'Файлы']] : [['common', 'Общие чаты'], ['media', 'Медиа'], ['info', 'Info'], ['files', 'Файлы']];
      var chips = h('div', { class: 'mxu-chips' }), body = h('div'), cache = {}, TAB = {};
      TAB.info = function (box) {
        if (p.desc) box.appendChild(card(h('div', { class: 'mxu-row' }, h('div', { class: 'mxu-grow' }, h('div', { class: 'mxu-l', style: 'font-size:14px;color:var(--secondary-text-color,#8e8e93)' }, a.group ? 'Описание' : 'О себе'), h('div', { class: 'mxu-t', style: 'font-weight:400;font-size:17px;margin-top:3px;white-space:pre-wrap' }, p.desc)))));
        box.appendChild(infoCard(p));
      };
      TAB.common = function (box) {
        box.appendChild(h('div', { class: 'mxu-spin', style: 'margin:30px auto' }));
        rpc('common', { id: a.id }).then(function (r) {
          box.innerHTML = '';
          if (!r.chats.length) return box.appendChild(h('div', { class: 'mxu-empty' }, 'Общих групп нет'));
          var c = card();
          r.chats.forEach(function (g) {
            c.appendChild(h('div', { class: 'mxu-row click', onclick: function () { goChat({ id: g.id, group: true }); } }, avatar(g.photo, g.title), h('div', { class: 'mxu-grow' }, h('div', { class: 'mxu-t' }, g.title), g.members ? h('div', { class: 'mxu-s' }, g.members + ' участн.') : null)));
          });
          box.appendChild(c);
        }, function (e) { box.innerHTML = ''; box.appendChild(errBox(e)); });
      };
      TAB.media = function (box) {
        box.appendChild(h('div', { class: 'mxu-spin', style: 'margin:30px auto' }));
        rpc('media', { id: a.id, group: !!a.group, kind: 'media' }).then(function (r) {
          box.innerHTML = '';
          if (!r.items.length) return box.appendChild(h('div', { class: 'mxu-empty' }, 'Медиафайлов нет'));
          var g = h('div', { class: 'mxu-grid' });
          r.items.forEach(function (it) {
            var cell = h('div', { class: 'mxu-gi', onclick: function () { if (it.url) viewer(it.url, it.t === 'VIDEO' ? 'Видео' : 'Фото'); } });
            if (it.url) { var im = h('img', { alt: '', loading: 'lazy', src: imgUrl(it.url) }); im.onerror = function () { im.remove(); }; cell.appendChild(im); }
            if (it.t === 'VIDEO') cell.appendChild(h('span', { class: 'mxu-play' }, '▶'));
            g.appendChild(cell);
          });
          box.appendChild(g);
        }, function (e) { box.innerHTML = ''; box.appendChild(errBox(e)); });
      };
      TAB.files = function (box) {
        box.appendChild(h('div', { class: 'mxu-spin', style: 'margin:30px auto' }));
        rpc('media', { id: a.id, group: !!a.group, kind: 'files' }).then(function (r) {
          box.innerHTML = '';
          if (!r.items.length) return box.appendChild(h('div', { class: 'mxu-empty' }, 'Файлов нет'));
          var c = card();
          r.items.forEach(function (it) { c.appendChild(row({ icon: 'idcard', title: it.name || 'Файл', sub: [it.size ? fmtBytes(it.size) : '', it.time ? fmtDT(it.time) : ''].filter(Boolean).join(' · ') })); });
          box.appendChild(c); box.appendChild(hint('Чтобы скачать файл, откройте его в чате.'));
        }, function (e) { box.innerHTML = ''; box.appendChild(errBox(e)); });
      };
      function select(k) {
        [].forEach.call(chips.children, function (c) { c.classList.toggle('on', c.getAttribute('data-k') === k); });
        body.innerHTML = '';
        if (!cache[k]) { cache[k] = h('div'); TAB[k](cache[k]); }
        body.appendChild(cache[k]);
      }
      tabs.forEach(function (t) { chips.appendChild(h('button', { class: 'mxu-chip', 'data-k': t[0], onclick: function () { select(t[0]); } }, t[1])); });
      pg.body.appendChild(chips); pg.body.appendChild(body);
      select('info');
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
      row({ icon: 'info', title: 'Журнал bridge (pylog)', sub: 'Последние строки логов сервера', chev: 1, onclick: function () { window.open('/api/debug/pylog', '_blank'); } }),
      row({ icon: 'bug', title: 'Проверка навигации', sub: 'Открывает все экраны MAX и проверяет кнопку «Назад»', chev: 1, onclick: function () { navSelfTest(); } })
    ));
    pg.body.appendChild(hint('Строки «sync: …», «stories: …», «deleted: …» и «e2e: …» в консоли показывают, где тратится время при старте и что происходит с историями и шифрованием.'));
  };

  S.more = function () {
    var pg = page({ title: 'Дополнительно' });
    pg.body.appendChild(card(
      row({ icon: 'info', title: 'Функции клиента', chev: 1, onclick: function () { open('features'); } }),
      row({ icon: 'image', title: 'Просмотр GIF', chev: 1, onclick: function () { open('gif'); } }),
      row({ icon: 'bug', title: 'Отладка', chev: 1, onclick: function () { open('debug'); } })
    ));
    pg.body.appendChild(sec('Сервисы MAX'));
    pg.body.appendChild(card(
      row({ icon: 'info', title: 'Сферум', sub: 'Школьная платформа MAX', chev: 1, onclick: function () { openEntryApp('sferum', 'Сферум'); } }),
      row({ icon: 'link', title: 'Цифровой ID', sub: 'Документы и вход через Госуслуги', chev: 1, onclick: function () { openEntryApp('digital', 'Цифровой ID'); } }),
      row({ icon: 'info', title: 'Другие сервисы', sub: 'Всё, что пришло в конфиге аккаунта', chev: 1, onclick: function () { open('entryApps'); } })
    ));
    pg.body.appendChild(sec('Только в классическом интерфейсе'));
    pg.body.appendChild(card(
      row({ icon: 'bot', title: 'Кастомные боты', sub: 'Чаты с локальными ботами живут в классическом чате', chev: 1, onclick: function () { legacyOpen('bots', 'Кастомные боты'); } }),
      row({ icon: 'classic', title: 'Переключиться на классический интерфейс', chev: 1, onclick: function () { legacyOpen('switchClassic', 'Классический интерфейс'); } })
    ));
  };


  /* ------------------------------------------------------------ темы MAX (те же, что в классическом интерфейсе) */
  var TH_KEY = 'maxclient_tg_theme';
  var THEMES = [
    { id: 'default', name: 'Стандартная', sub: 'Тема Web K (как настроено в «Настройки чатов»)' },
    { id: 'dark', name: 'Тёмная', sub: 'Тёмно-синяя, как в Telegram', c: ['#4DA3FF', '#0E1621', '#17212B', '#FFFFFF', '#8E8E93', '#101921', '#182533', '#2B5278'] },
    { id: 'simple', name: 'Простая', sub: 'Светлый минимализм', c: ['#007aff', '#f5f7fa', '#ffffff', '#333333', '#7a7a7a', '#e2e5e9', '#ffffff', '#d9ecff'] },
    { id: 'neon', name: 'Неон', sub: 'Тёмная с розово-бирюзовыми акцентами', c: ['#ff007f', '#0d0e15', '#15161f', '#00ffcc', '#7a90a0', '#232538', '#15161f', '#7a0040'] },
    { id: 'forest', name: 'Летний лес', sub: 'Светлая зелёная', c: ['#4caf50', '#f0f4f1', '#ffffff', '#2c3e2b', '#6b8065', '#d7e3d4', '#ffffff', '#dcedc8'] },
    { id: 'sepia', name: 'Сепия', sub: 'Тёплая бумажная', c: ['#b8860b', '#f4efe6', '#faf6ef', '#5c4b3a', '#8a7a6a', '#e0d5c8', '#faf6ef', '#ecd9b8'] },
    { id: 'space', name: 'Космос', sub: 'Глубокий синий', c: ['#6c8cff', '#0a0e27', '#141832', '#b8c6ff', '#7a8abf', '#2a3060', '#1a2040', '#3a52b8'] }
  ];
  function rgbOf(hex) { var n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255); }
  function getTheme() { try { return localStorage.getItem(TH_KEY) || 'default'; } catch (e) { return 'default'; } }
  function applyTheme(id) {
    var t = THEMES.filter(function (x) { return x.id === id; })[0];
    var el = document.getElementById('mxu-theme');
    if (!t || !t.c) { if (el) el.remove(); return; }
    var c = t.c, v = {
      'primary-color': c[0], 'primary-color-rgb': rgbOf(c[0]), 'background-color': c[1], 'surface-color': c[2], 'surface-color-rgb': rgbOf(c[2]),
      'primary-text-color': c[3], 'primary-text-color-rgb': rgbOf(c[3]), 'secondary-text-color': c[4], 'border-color': c[5],
      'message-background-color': c[6], 'message-out-background-color': c[7], 'chat-input-background': c[2]
    };
    var css = ':root,:root.night,:root:not(.night){' + Object.keys(v).map(function (k) { return '--' + k + ':' + v[k] + '!important'; }).join(';') + '}';
    if (!el) { el = document.createElement('style'); el.id = 'mxu-theme'; document.head.appendChild(el); }
    el.textContent = css;
  }
  function setTheme(id) { try { localStorage.setItem(TH_KEY, id); } catch (e) { } applyTheme(id); }
  applyTheme(getTheme());

  S.themes = function () {
    var pg = page({ title: 'Тема оформления' });
    function draw() {
      pg.body.innerHTML = '';
      var cur = getTheme();
      pg.body.appendChild(card.apply(null, THEMES.map(function (t) {
        return row({ radio: 1, sel: cur === t.id, title: t.name, sub: t.sub, onclick: function () { setTheme(t.id); draw(); } });
      })));
      pg.body.appendChild(hint('Темы те же, что в классическом интерфейсе. Применяются сразу и сохраняются на этом устройстве.'));
    }
    draw();
  };


  /* ------------------------------------------------------------ Устройства (сеансы аккаунта) */
  S.sessions = function () {
    var pg = page({ title: 'Устройства' });
    function when(t) { if (!t) return ''; var d = new Date(t > 1e11 ? t : t * 1000); return isNaN(d) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); }
    function srow(x) { return row({ icon: 'device', title: x.client || 'Устройство', sub: [x.info, x.location, when(x.time)].filter(Boolean).join(' · ') }); }
    function render() {
      pg.spin();
      jget('/api/sessions').then(function (d) {
        pg.body.innerHTML = '';
        var list = d.sessions || [], cur = list.filter(function (x) { return x.current; }), rest = list.filter(function (x) { return !x.current; });
        if (cur.length) { pg.body.appendChild(sec('Это устройство')); pg.body.appendChild(card.apply(null, cur.map(srow))); }
        pg.body.appendChild(sec('Другие сеансы'));
        pg.body.appendChild(rest.length ? card.apply(null, rest.map(srow)) : hint('Других активных сеансов нет.'));
        pg.body.appendChild(h('div', { class: 'mxu-btns' }, btn('Выйти на всех устройствах, кроме этого', 'danger', function () {
          if (!confirm('Завершить все сеансы, кроме текущего?')) return;
          jpost('/api/sessions/close').then(function () { toast('Другие сеансы завершены'); render(); }, function (e) { toast('Ошибка: ' + e.message); });
        }, 'trash')));
        pg.body.appendChild(hint('Если вход с неизвестного устройства — не ваш, завершите остальные сеансы.'));
      }, function (e) { pg.body.innerHTML = ''; pg.body.appendChild(errBox(e)); });
    }
    render();
  };
  /* Приложения из конфига входа (settings-entry-banners): «Сферум», «Цифровой ID» и всё остальное, что прислал сервер.
     Названия — по файлам иконок; нужен, когда нужного приложения нет под ожидаемым именем. */
  S.entryApps = function () {
    var pg = page({ title: 'Другие сервисы' });
    pg.spin();
    rpc('entryApps').then(function (e) {
      pg.body.innerHTML = '';
      var list = (e && e.banners) || [];
      if (!list.length) { pg.body.appendChild(hint(e && e.banners ? 'В конфиге аккаунта нет приложений.' : 'Конфиг ещё не получен — переподключитесь и откройте экран снова.')); return; }
      pg.body.appendChild(sec('Приложения из конфига аккаунта'));
      pg.body.appendChild(card.apply(null, list.map(function (b) {
        var name = entryIconName(b.icon);
        return row({ icon: 'link', title: name, sub: 'id ' + b.appid, chev: 1, onclick: function () {
          toast('Открываем «' + name + '»…');
          launchMini(b.appid, name).catch(function (x) { toast(name + ': ' + (x && x.message || x)); });
        } });
      })));
      pg.body.appendChild(hint('Названия взяты из файлов иконок. Приложение открывается так же, как «Сферум».'));
    }, function (e) { pg.body.innerHTML = ''; pg.body.appendChild(errBox(e)); });
  };
  /* ссылка из служебного сообщения «Новый вход» (max.ru/:settings/devices) открывает наш экран, а не сайт */
  (function () {
    function isDev(u) { return /max\.ru\/:settings\/devices/i.test(u || ''); }
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href],[data-href],[data-url]');
      var u = a && (a.getAttribute('href') || a.getAttribute('data-href') || a.getAttribute('data-url'));
      if (isDev(u)) { e.preventDefault(); e.stopPropagation(); open('sessions'); }
    }, true);
    var wo = window.open;
    window.open = function (u) { if (isDev(String(u))) { open('sessions'); return null; } return wo.apply(window, arguments); };
  })();

  /* ------------------------------------------------------------ Функции клиента */
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function lsCount(k) { try { var o = JSON.parse(localStorage.getItem(k) || '{}'); return Object.keys(o).filter(function (x) { return o[x]; }).length; } catch (e) { return 0; } }
  function flag(key, def) { return lsGet(key, def ? '1' : '0') === '1'; }
  function tog(o) {
    return row({ icon: o.icon, title: o.title, sub: o.sub, toggle: { on: o.on(), onchange: function (v) { o.set(v); if (o.note) toast(o.note); } } });
  }

  S.features = function () {
    var pg = page({ title: 'Функции клиента' });
    var b = pg.body;
    b.appendChild(sec('Оформление'));
    var th = THEMES.filter(function (x) { return x.id === getTheme(); })[0] || THEMES[0];
    b.appendChild(card(row({ icon: 'image', title: 'Тема оформления', value: th.name, chev: 1, onclick: function () { open('themes'); } })));

    b.appendChild(sec('Приватность'));
    var gh = lsCount('maxclient_ghost_read'), ar = lsCount('maxclient_autoreply');
    b.appendChild(card(
      row({ icon: 'eyeoff', title: 'Режим призрака', sub: 'Не отмечать сообщения прочитанными. Меню чата (⋮) → «Призрак»', value: gh ? 'чатов: ' + gh : 'выкл' }),
      row({ icon: 'bot', title: 'Автоответ', sub: 'Пока только в классическом интерфейсе', value: ar ? 'чатов: ' + ar : 'выкл' })
    ));
    b.appendChild(hint('Призрак включается для каждого чата в его меню (⋮); сквозное шифрование — там же, в личных чатах. Настройки призрака общие с классическим интерфейсом.'));

    b.appendChild(sec('Уведомления'));
    b.appendChild(card(tog({ icon: 'bell', title: 'Текст в уведомлениях', sub: 'Показывать превью сообщения в push', on: function () { return lsGet('maxclient_notif_preview', '1') !== '0'; }, set: function (v) { lsSet('maxclient_notif_preview', v ? '1' : '0'); } })));

    b.appendChild(sec('Инструменты'));
    b.appendChild(card(
      row({ icon: 'shield', title: 'Скам-проверка (ИИ)', sub: 'Проверка входящих сообщений', chev: 1, onclick: function () { open('scam'); } }),
      row({ icon: 'bell', title: 'Уведомления и push', chev: 1, onclick: function () { open('notifications'); } }),
      row({ icon: 'db', title: 'Использование памяти', sub: 'Кэш картинок и файлов', chev: 1, onclick: function () { open('storage'); } }),
      row({ icon: 'device', title: 'Устройства (сеансы)', sub: 'Где выполнен вход, выход на других', chev: 1, onclick: function () { open('sessions'); } }),
      row({ icon: 'device', title: 'Устройство (протокол)', chev: 1, onclick: function () { open('device'); } }),
      row({ icon: 'image', title: 'Просмотр GIF', chev: 1, onclick: function () { open('gif'); } })
    ));

    b.appendChild(sec('Отладка'));
    b.appendChild(card(
      tog({ icon: 'bug', title: 'Панель логов', on: function () { return flag('maxclient_log_panel_enabled', false); }, set: function (v) { lsSet('maxclient_log_panel_enabled', v ? '1' : '0'); }, note: 'Применится после перезапуска' }),
      tog({ icon: 'bug', title: 'Дамп отладки', sub: 'Сохранять подробный дамп запросов', on: function () { return flag('maxclient_debug_dump_enabled', false); }, set: function (v) { lsSet('maxclient_debug_dump_enabled', v ? '1' : '0'); }, note: 'Применится после перезапуска' }),
      row({ icon: 'bug', title: 'Консоль отладки', chev: 1, onclick: function () { open('debug'); } })
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


  /* ------------------------------------------------------------ удалённые сообщения — красным (воркер дописывает «🗑 Удалено») */
  (function () {
    var e = document.createElement('style'); e.id = 'mxu-del';
    e.textContent = '.bubble.mx-del .bubble-content{background:rgba(229,57,53,.16)!important;box-shadow:inset 3px 0 0 #e53935}' +
      '.bubble.mx-del .message i:last-of-type{color:#ff5252!important;font-style:normal;font-weight:600}';
    document.head.appendChild(e);
    var pend = false;
    function scan() {
      pend = false;
      [].forEach.call(document.querySelectorAll('.bubble:not(.mx-del) .message'), function (m) {
        if (m.textContent.indexOf('🗑 Удалено') !== -1) { var b = m.closest('.bubble'); if (b) b.classList.add('mx-del'); }
      });
    }
    new MutationObserver(function () { if (!pend) { pend = true; requestAnimationFrame(scan); } })
      .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  })();

  /* ------------------------------------------------------------ призрак и E2E из меню чата */
  var GH_KEY = 'maxclient_ghost_read';
  function ghMap() { try { return JSON.parse(localStorage.getItem(GH_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function ghSync() { var m = ghMap(); jpost('/api/ghost', { chatIds: Object.keys(m).filter(function (k) { return m[k]; }) }).catch(function () { }); }
  ghSync(); setInterval(ghSync, 30000);
  function chatIdOf(pid) { return rpc(pid < 0 ? 'chat' : 'contact', { id: Math.abs(pid) }).then(function (r) { return r && r.chatId; }); }
  function setLabel(it, t) { var tx = it.querySelector('.btn-menu-item-text'); if (tx) tx.textContent = t; else it.textContent = t; }
  function labelGhost(it) {
    var pid = currentPeer(); if (pid == null) return;
    chatIdOf(pid).then(function (cid) { if (cid != null) setLabel(it, ghMap()[cid] ? 'Призрак: включён' : 'Призрак (не читать)'); }, function () { });
  }
  function toggleGhost() {
    var pid = currentPeer(); if (pid == null) return toast('Не удалось определить чат');
    chatIdOf(pid).then(function (cid) {
      if (cid == null) return toast('Чат ещё не создан');
      var m = ghMap(); m[cid] = !m[cid];
      try { localStorage.setItem(GH_KEY, JSON.stringify(m)); } catch (e) { }
      ghSync();
      toast(m[cid] ? 'Призрак включён: «прочитано» не отправляется' : 'Призрак выключен');
    }, function (e) { toast('Ошибка: ' + e.message); });
  }
  function toggleE2e() {
    var pid = currentPeer(); if (pid == null) return toast('Не удалось определить чат');
    if (pid < 0) return toast('Шифрование работает только в личных чатах');
    function act(op, msg) { return rpc('e2e', { id: pid, op: op }, 30000).then(function () { toast(msg); }, function (e) { toast('Ошибка: ' + e.message); }); }
    rpc('e2e', { id: pid, op: 'status' }).then(function (r) {
      if (!r.dialog) return toast('Шифрование работает только в личных чатах');
      if (r.status === 'active') { if (confirm('Выключить сквозное шифрование в этом чате?')) act('off', 'Шифрование выключено'); }
      else if (r.status === 'pending') toast('Ждём подтверждения собеседника');
      else if (r.status === 'incoming') {
        if (confirm('Собеседник предлагает включить сквозное шифрование. Принять?')) act('accept', 'Шифрование включено');
        else if (confirm('Отклонить запрос?')) act('decline', 'Запрос отклонён');
      } else if (confirm('Включить сквозное шифрование? Собеседнику придёт запрос.')) act('on', 'Запрос на шифрование отправлен');
    }, function (e) { toast('Ошибка: ' + e.message); });
  }

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
      var ref = items[Math.max(0, items.length - 1)];
      last.parentNode.insertBefore(cloneItem(last, 'Info (MAX)', function () {
        var pid = currentPeer();
        if (pid == null) return toast('Не удалось определить чат');
        open('contact', pid < 0 ? { id: Math.abs(pid), group: true } : { id: pid });
      }), ref);
      var gi = cloneItem(last, 'Призрак (не читать)', toggleGhost);
      last.parentNode.insertBefore(gi, ref);
      labelGhost(gi);
      last.parentNode.insertBefore(cloneItem(last, 'Шифрование (E2E)', toggleE2e), ref);
    }
  }
  new MutationObserver(function () { document.querySelectorAll('.btn-menu').forEach(patchMenu); }).observe(document.documentElement, { childList: true, subtree: true });

  /* Тап по шапке чата / аватарке в сообщении открывает наш профиль (вместо боковой панели Web K) */
  function openProfileOf(pid) {
    if (pid === 100 || pid === 0 || !isFinite(pid)) { if (pid === 100) open('profile'); return pid === 100; }
    open('contact', pid < 0 ? { id: Math.abs(pid), group: true } : { id: pid });
    return true;
  }
  function peerOfHeader() {
    var av = document.querySelector('.chat-info [data-peer-id]');
    if (av && av.dataset.peerId && isFinite(Number(av.dataset.peerId))) return Number(av.dataset.peerId);
    return currentPeer();
  }
  document.addEventListener('click', function (e) {
    var t = e.target; if (!t || !t.closest || (root && root.contains(t))) return;
    var done = false;
    if (t.closest('.chat-info') && !t.closest('button, .btn-icon, .chat-utils, a')) {
      var pid = peerOfHeader(); if (pid != null) done = openProfileOf(pid);
    } else {
      var av = t.closest('.bubbles [data-peer-id]');
      if (av && (av.tagName === 'AVATAR-ELEMENT' || /(^|\s)(avatar|user-avatar)(\s|$)/.test(av.className || ''))) {
        var id2 = Number(av.dataset.peerId); if (id2 && isFinite(id2) && id2 > 0) done = openProfileOf(id2);
      }
    }
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);



  /* ------------------------------------------------------------ скин списков: круглый поиск, вкладки-«пилюли» (как в референсе) */
  (function () {
    var C = [
      '.input-search-input{border-radius:28px!important;background:var(--surface-color)!important}',
      '.menu-horizontal-div{background:var(--surface-color);border-radius:30px;padding:5px;margin:6px 12px 8px!important;gap:2px;overflow-x:auto;scrollbar-width:none}',
      '.menu-horizontal-div::-webkit-scrollbar{display:none}',
      '.menu-horizontal-div-item{border-radius:24px!important;padding:11px 18px!important;font-weight:600}',
      '.menu-horizontal-div-item.active{background:rgba(var(--primary-color-rgb,135,116,225),.2)!important;color:var(--primary-color)!important}',
      '.menu-horizontal-div-item:not(.active):hover{background:transparent!important}',
      '.menu-horizontal-div-item>i{display:none!important}',
      /* поиск главного списка не должен ловить тапы, пока поверх открыта другая вкладка сайдбара (Контакты, Настройки и т.д.) */
      '#column-left .sidebar-slider:has(>.sidebar-slider-item.active:not(.item-main)) .item-main{pointer-events:none!important}',
      '#column-left .sidebar-slider:has(>.sidebar-slider-item.active:not(.item-main)) .item-main input{visibility:hidden!important}'
    ].join('');
    var e = document.createElement('style'); e.id = 'mxu-skin'; e.textContent = C; document.head.appendChild(e);
  })();

  /* ------------------------------------------------------------ плавающая нижняя панель (Чаты / Контакты / Настройки / Профиль) */
  (function () {
    var NAVCSS = [
      '.mxn{display:none;position:fixed;left:50%;bottom:calc(12px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:min(92vw,520px);z-index:60;padding:6px;border-radius:34px;gap:4px;',
      'background:rgba(var(--surface-color-rgb,23,33,43),.88);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);box-shadow:0 6px 24px rgba(0,0,0,.35);color:var(--secondary-text-color,#8e8e93)}',
      '.mxn button{flex:1;border:0;background:none;color:inherit;font:inherit;font-size:13px;font-weight:600;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 4px 7px;border-radius:28px;cursor:pointer;-webkit-tap-highlight-color:transparent}',
      '.mxn button.on{color:var(--primary-color,#8774e1);background:rgba(128,128,128,.2)}',
      '.mxn button:active{background:rgba(128,128,128,.28)}',
      '@media (max-width:899px){body.is-left-column-shown .mxn{display:flex}',
      'body.is-left-column-shown #column-left .chatlist-container{padding-bottom:96px}',
      'body.is-left-column-shown #column-left .btn-circle.btn-corner{bottom:92px!important}}'
    ].join('');
    var stN = document.createElement('style'); stN.id = 'mxn-css'; stN.textContent = NAVCSS; document.head.appendChild(stN);

    var cur = 'chats', bar = null, btns = {};
    function visible(el) { return !!(el && el.offsetParent !== null); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    /* вернуться на список чатов: закрыть экраны MAX и вкладки сайдбара Web K */
    function toRoot() {
      closeAll();
      var n = 0;
      return (function step() {
        var b = [].slice.call(document.querySelectorAll('#column-left .sidebar-slider-item.active .sidebar-close-button, #column-left .tabs-tab.active .sidebar-close-button')).filter(visible)[0];
        if (!b || n++ > 4) return Promise.resolve();
        b.click();
        return sleep(260).then(step);
      })();
    }
    function menuClick(re) {
      var t = document.querySelector('#column-left .sidebar-header .btn-menu-toggle, #column-left .left-sidebar-burger .btn-menu-toggle, #column-left .sidebar-header__btn-container button');
      if (!t) return Promise.resolve(false);
      t.click();
      return sleep(180).then(function () {
        var items = [].slice.call(document.querySelectorAll('.btn-menu.active .btn-menu-item, .btn-menu.is-visible .btn-menu-item, .btn-menu .btn-menu-item')).filter(visible);
        var it = items.filter(function (el) { return re.test(txt(el)); })[0];
        if (it) { it.click(); return true; }
        t.click(); return false;
      });
    }
    function go(id) {
      if (id === 'profile') { set('profile'); open('profile'); return; }
      toRoot().then(function () {
        set(id);
        if (id === 'contacts') menuClick(/^(Контакты|Contacts)$/).then(function (ok) { if (!ok) toast('Не удалось открыть «Контакты»'); });
        else if (id === 'settings') menuClick(/^(Настройки|Settings)$/).then(function (ok) { if (!ok) toast('Не удалось открыть «Настройки»'); });
      });
    }
    function set(id) { cur = id; Object.keys(btns).forEach(function (k) { btns[k].classList.toggle('on', k === id); }); }
    function mk(id, label, ic) {
      var b = h('button', { type: 'button', 'aria-label': label, onclick: function () { go(id); } }, icon(ic, 26), h('span', null, label));
      btns[id] = b; return b;
    }
    bar = h('div', { class: 'mxn', role: 'navigation' },
      mk('chats', 'Чаты', 'chat'), mk('contacts', 'Контакты', 'user'), mk('settings', 'Настройки', 'gear'), mk('profile', 'Профиль', 'idcard'));
    set('chats');
    function mount() { if (document.body) document.body.appendChild(bar); else document.addEventListener('DOMContentLoaded', mount); }
    mount();
    /* закрыли экран MAX / вернулись на список — подсветка «Чаты» */
    new MutationObserver(function () { if (cur === 'profile' && !document.querySelector('.mxu-root')) set('chats'); }).observe(document.documentElement, { childList: true, subtree: true });
  })();

  /* внешние оверлеи (фрейм классического UI) встают в тот же стек «Назад» */
  window.__mxBackLayer = function (close) { var L = layerPush(function () { close(); }, false); return function () { layerRelease(L); }; };
  /* Звонки (static/calls.js). В оболочке старого APK tg/index.html не содержит <script src="/calls.js"> и по OTA не обновляется,
     поэтому, если модуля нет, подгружаем его сами (calls.js и mx-ui.js едут по OTA без пересборки). */
  var callsP = null;
  function wireCalls(M) {
    if (M.__mxWired) return M;
    M.__mxWired = true;
    /* имя и фото звонящего для экрана входящего звонка */
    M.setResolver(function (id) {
      return rpc('contact', { id: id }).then(function (p) {
        var ph = p && (p.photoSmall || p.photo);
        return { name: p && p.name, avatarUrl: ph ? imgUrl(ph) : null };
      });
    });
    return M;
  }
  function ensureCalls() {
    if (window.MaxCalls) return Promise.resolve(wireCalls(window.MaxCalls));
    if (callsP) return callsP;
    callsP = new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = '/calls.js';
      sc.onload = function () { window.MaxCalls ? res(wireCalls(window.MaxCalls)) : (callsP = null, rej(new Error('calls.js загружен, но модуль не создан'))); };
      sc.onerror = function () { callsP = null; rej(new Error('не удалось загрузить /calls.js (обнови bridge.py и calls.js)')); };
      document.head.appendChild(sc);
    });
    return callsP;
  }
  /* ------------------------------------------------------------ самопроверка навигации («Отладка → Проверка навигации»)
     Открывает экраны MAX, нажимает «Назад» как система (нативный history.back, без пометки «чужой») и сверяет слои, DOM и глубину истории.
     Ловит «уход слишком глубоко назад»: незакрытые слои, лишние записи истории, зависшие меню и оверлеи.
     Касания и свайпы внутри самого Web K (чаты, шторки) отсюда не проверяются. */
  function navSelfTest() {
    if (navSelfTest.running) return; navSelfTest.running = true;
    var SCREENS = ['profile', 'invite', 'notifications', 'storage', 'device', 'scam', 'about', 'gif', 'debug', 'more', 'themes', 'sessions', 'features', 'entryApps'];
    var res = [], base = null;
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function snap() { return { layers: layers.length, dom: document.querySelectorAll('.mxu-page').length, idx: navIdx(), menu: document.querySelectorAll('.mxu-menu').length, ovl: document.querySelectorAll('#mx-upd,#mx-wa-overlay').length }; }
    function rec(name, ok, note) { res.push({ name: name, ok: ok, note: note || '' }); }
    function check(name, got, want) {
      var bad = Object.keys(want).filter(function (k) { return want[k] !== undefined && got[k] !== want[k]; })
        .map(function (k) { return k + ': ожидали ' + want[k] + ', стало ' + got[k]; });
      rec(name, !bad.length, bad.join('; '));
    }
    function sysBack() { try { ownBack(); } catch (e) { } }
    function nx(d) { return base.idx == null ? undefined : base.idx + d; }
    var steps = [];
    steps.push(function () {
      closeAll(); return wait(500).then(function () { base = snap(); rec('Старт: нет открытых экранов и слоёв', base.layers === 0 && base.dom === 0, JSON.stringify(base)); });
    });
    SCREENS.forEach(function (k) {
      steps.push(function () {
        try { open(k); } catch (e) { rec(k + ': ошибка открытия', false, String(e && e.message || e)); return; }
        return wait(450).then(function () {
          check(k + ': экран открыт', snap(), { layers: base.layers + 1, dom: base.dom + 1, idx: nx(1) });
          sysBack(); return wait(600);
        }).then(function () { check(k + ': «Назад» закрыл ровно его', snap(), { layers: base.layers, dom: base.dom, idx: nx(0) }); });
      });
    });
    steps.push(function () {
      open('more'); open('themes');
      return wait(450).then(function () {
        check('Два экрана подряд: одна страховочная запись на оба', snap(), { layers: base.layers + 2, dom: base.dom + 2, idx: nx(1) });
        sysBack(); return wait(600);
      }).then(function () {
        check('«Назад» №1 закрыл только верхний', snap(), { layers: base.layers + 1, dom: base.dom + 1, idx: nx(1) });
        sysBack(); return wait(600);
      }).then(function () { check('«Назад» №2 закрыл нижний, история на базе', snap(), { layers: base.layers, dom: base.dom, idx: nx(0) }); });
    });
    steps.push(function () {
      open('about'); open('more');
      return wait(450).then(function () { sysBack(); return wait(60); }).then(function () { sysBack(); return wait(800); })
        .then(function () { check('Два быстрых «Назад» подряд (60 мс): всё закрыто, глубже не ушли', snap(), { layers: base.layers, dom: base.dom, idx: nx(0) }); });
    });
    steps.push(function () {
      open('about');
      return wait(450).then(function () { showMenu([{ icon: 'info', text: 'Тест', run: function () { } }]); return wait(150); })
        .then(function () {
          check('Меню открыто поверх экрана', snap(), { layers: base.layers + 2, menu: 1 });
          sysBack(); return wait(500);
        }).then(function () {
          check('«Назад» закрыл МЕНЮ, а не экран под ним', snap(), { layers: base.layers + 1, dom: base.dom + 1, menu: 0 });
          sysBack(); return wait(600);
        }).then(function () { check('Следующий «Назад» закрыл экран', snap(), { layers: base.layers, dom: base.dom, menu: 0, idx: nx(0) }); });
    });
    steps.push(function () {
      showUpdatePrompt({ tag: 'test', url: '#' });
      return wait(300).then(function () {
        check('Окно «новая версия» — слой «Назад»', snap(), { layers: base.layers + 1, ovl: 1, idx: nx(1) });
        sysBack(); return wait(500);
      }).then(function () { check('«Назад» закрыл окно «новая версия»', snap(), { layers: base.layers, ovl: 0, idx: nx(0) }); });
    });
    steps.push(function () {
      appOverlay('about:blank');
      return wait(300).then(function () {
        check('Оверлей мини-приложения — слой «Назад»', snap(), { layers: base.layers + 1, ovl: 1, idx: nx(1) });
        sysBack(); return wait(500);
      }).then(function () { check('«Назад» закрыл оверлей мини-приложения', snap(), { layers: base.layers, ovl: 0, idx: nx(0) }); });
    });
    return steps.reduce(function (p, f) { return p.then(f); }, Promise.resolve())
      .catch(function (e) { rec('Проверка прервана', false, String(e && e.message || e)); })
      .then(function () { closeAll(); return wait(400); })
      .then(function () {
        navSelfTest.running = false;
        var okN = res.filter(function (r) { return r.ok; }).length;
        var text = 'Проверка навигации: ' + okN + '/' + res.length + ' ок (Navigation API: ' + (navIdx() == null ? 'нет' : 'есть') + ')\n' +
          res.map(function (r) { return (r.ok ? '✔ ' : '✘ ') + r.name + (r.note ? ' — ' + r.note : ''); }).join('\n');
        try { console.log(text); } catch (e) { }
        var pg = page({ title: 'Проверка навигации' });
        pg.body.appendChild(card.apply(null, res.map(function (r) { return row({ icon: 'info', title: (r.ok ? '✔ ' : '✘ ') + r.name, sub: r.note || '' }); })));
        pg.body.appendChild(card(row({ icon: 'link', title: 'Скопировать отчёт', chev: 1, onclick: function () { copy(text, 'Отчёт'); } })));
        toast(okN + '/' + res.length + ' проверок пройдено');
      });
  }
  window.__mxNavSelfTest = navSelfTest;
  /* ------------------------------------------------------------ уведомление о новой версии (как showUpdatePrompt в roblox-studio-web)
     Сервер (/api/update-check) сравнивает versionCode установленного APK с последним stable-релизом на GitHub; hot-релизы не в счёт.
     Показываем один раз за сессию; «Позже» просто закрывает окно, при следующем запуске приложения напомним снова. */
  function showUpdatePrompt(rel) {
    if (document.getElementById('mx-upd')) return;
    var label = rel.versionName ? 'v' + rel.versionName : rel.tag;
    var L = null;
    function close() { if (L) { var x = L; L = null; layerRelease(x); } dim.remove(); }
    function go() { close(); window.open(rel.url, '_blank', 'noopener'); }
    var canInstall = !!(window.AndroidApkInstaller && window.AndroidApkInstaller.install && rel.apkUrl);
    function install() {
      close(); toast('Скачиваем обновление…');
      try { window.AndroidApkInstaller.install(rel.apkUrl, rel.apkName || ''); } catch (e) { window.open(rel.url, '_blank', 'noopener'); }
    }
    var btnRow = h('div', { class: 'mxu-btns', style: 'margin:16px 0 0' });
    (canInstall ? [btn('Установить', '', install), btn('Релиз', 'ghost', go), btn('Позже', 'ghost', close)] : [btn('Перейти', '', go), btn('Позже', 'ghost', close)])
      .forEach(function (b) { btnRow.appendChild(b); });
    var dim = h('div', { id: 'mx-upd', style: 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px' },
      h('div', { style: 'width:min(92vw,360px);box-sizing:border-box;border-radius:20px;background:var(--surface-color,#212121);color:var(--primary-text-color,#fff);padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.5)' },
        h('div', { style: 'font-size:18px;font-weight:600' }, '🚀 Вышла новая версия'),
        h('div', { style: 'margin-top:10px;font-size:14px;line-height:1.45;opacity:.85' }, 'Вышла версия ' + label + '. Обновите приложение, чтобы получить новые функции и исправления.'),
        btnRow));
    dim.addEventListener('click', function (e) { if (e.target === dim) close(); });
    document.body.appendChild(dim);
    L = layerPush(function () { L = null; dim.remove(); }, false);   /* системная «Назад» закрывает окно, а не уходит глубже по истории Web K */
  }
  function checkUpdate() {
    try { if (sessionStorage.getItem('mx_upd_shown')) return; } catch (e) { }
    jget('/api/update-check').then(function (d) {
      if (!d || !d.available || !d.latest) return;
      try { sessionStorage.setItem('mx_upd_shown', '1'); } catch (e) { }
      showUpdatePrompt(d.latest);
    }, function () { /* нет сети — молча: обновление не критично */ });
  }
  setTimeout(checkUpdate, 6000);
  ensureCalls().catch(function () { });   /* входящие звонки нужны, даже если профиль не открывали */
  /* ------------------------------------------------------------ мост мини-приложений MAX (по Komet: lib/frontend/screens/webapp/web_app_bridge.dart)
     Web K сам понимает события в стиле Telegram (web_app_ready, device/secure storage, biometry …). Здесь — то, что у MAX по-своему:
     телефон (op 106), «поделиться», ссылки max.ru, скачивание, тактильный отклик, launch_context, viewport, NFC.
     Всё, что отдаёт данные наружу или открывает что-то на устройстве, выполняется ТОЛЬКО после подтверждения пользователя
     (вместо «жеста» из Komet — мы не видим касаний внутри чужого iframe). Имена WebAppXxx из Komet приводятся к web_app_xxx;
     ответ уходит под тем же именем события, что и запрос. Не подтверждено живым мини-приложением: формат сообщений iframe→родитель. */
  var WA = (function () {
    /* slug'и кодов ошибок — как _methodSlugs в Komet; для всего остального — unsupported_method */
    var SLUG = { request_phone: 'request_phone', open_max_link: 'open_max_link', share: 'web_app_share', max_share: 'web_app_max_share', download_file: 'download_file',
      open_code_reader: 'open_code_reader', change_screen_brightness: 'change_screen_brightness', nfc_emulate_nfc_tag: 'nfc_emulate_nfc_tag',
      nfc_open_system_settings: 'nfc_open_system_settings', verify_mobile_id: 'verify_mobile_id', get_launch_context: 'launch_context', get_viewport_size: 'get_viewport_size' };
    var SILENT = { WebAppReady: 1, WebAppStat: 1, WebAppUrlInterceptor: 1, WebAppBackButtonPressed: 1 };
    var deny = {};

    function isAppFrame(src) {
      if (!src || src === window) return false;
      var fr = document.getElementsByTagName('iframe');
      for (var i = 0; i < fr.length; i++) { try { if (fr[i].contentWindow === src) return true; } catch (e) { } }
      return false;
    }
    function frameEl(src) {
      var fr = document.getElementsByTagName('iframe');
      for (var i = 0; i < fr.length; i++) { try { if (fr[i].contentWindow === src) return fr[i]; } catch (e) { } }
      return null;
    }
    function parse(d) {
      var m = d;
      if (typeof d === 'string') { try { m = JSON.parse(d); } catch (e) { return null; } }
      if (!m || typeof m !== 'object') return null;
      var type = m.eventType || m.method || m.name || m.event;
      if (typeof type !== 'string') return null;
      var data = m.eventData !== undefined ? m.eventData : (m.data !== undefined ? m.data : m.payload);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
      if (!data || typeof data !== 'object') data = {};
      return { type: type, data: data };
    }
    function norm(t) {
      if (/^WebApp[A-Z]/.test(t)) return 'web_app_' + t.slice(6).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      return t;
    }
    function slug(n) { return SLUG[n.replace(/^web_app_/, '')] || 'unsupported_method'; }
    function rid(d) { return d.requestId != null ? String(d.requestId) : undefined; }
    function reply(src, type, data) {
      try { src.postMessage(JSON.stringify({ eventType: type, eventData: data || {} }), '*'); } catch (e) { }
    }
    function ok(src, type, d, status) { var o = { status: status }; if (rid(d)) o.requestId = rid(d); reply(src, type, o); }
    function fail(src, type, n, d, reason) {
      var id = rid(d); if (!id) return;
      reply(src, type, { requestId: id, error: { code: 'client.' + slug(n) + '.' + reason } });
    }
    function ask(kind, text) {
      var now = Date.now();
      if (deny[kind] && now - deny[kind] < 10000) return false;   /* после отказа не засыпаем окнами подтверждения */
      var yes = false; try { yes = confirm(text); } catch (e) { }
      if (!yes) deny[kind] = now;
      return yes;
    }
    function cut(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '…' : t; }
    function safeUrl(u) {
      u = String(u || '').trim();
      if (u.charAt(0) === '/') u = 'https://max.ru' + u;
      try { var x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; } catch (e) { return null; }
    }
    function hostOf(u) { try { return new URL(u).host; } catch (e) { return ''; } }
    function shareText(d) {
      var parts = [];
      if (d.text != null && String(d.text) !== '') parts.push(String(d.text));
      if (d.link != null && String(d.link) !== '') parts.push(String(d.link));
      return parts.length ? parts.join('\n') : null;
    }
    /* Ссылка из мини-приложения: в APK — встроенный браузер (сайт остаётся внутри приложения, возврат externalCallback=1 перехватывается),
       в обычном браузере — новая вкладка. */
    function openInApp(u) {
      try { if (window.AndroidInAppBrowser && window.AndroidInAppBrowser.open) { window.AndroidInAppBrowser.open(u); return; } } catch (e) { }
      window.open(u, '_blank', 'noopener');
    }
    function vib(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { } }

    var H = {
      /* номер телефона → op 106 (после подтверждения) */
      web_app_request_phone: function (src, type, n, d) {
        var bot = src && src.__botId > 0 ? src.__botId : currentPeer();   /* нативное окно знает своего бота, iframe — по открытому чату */
        if (bot == null || bot <= 0) return fail(src, type, n, d, 'request_error');
        if (!ask('phone', 'Передать номер телефона?\n\nМини-приложение получит ваш номер телефона.')) return fail(src, type, n, d, 'user_refused_provide_phone_number');
        jpost('/api/web-app-phone', { botId: bot }).then(function (r) {
          var o = { phone: r.phone, hash: r.hash, authDate: r.authDate }; if (rid(d)) o.requestId = rid(d);
          reply(src, type, o);
        }, function () { fail(src, type, n, d, 'request_error'); });
      },
      /* ссылка max.ru / внешняя */
      web_app_open_max_link: function (src, type, n, d) {
        var u = safeUrl(d.url || d.path_full);
        if (!u) return;
        if (!ask('link', 'Мини-приложение хочет открыть ссылку:\n\n' + cut(u, 200) + '\n\nОткрыть?')) return;
        openInApp(u);
      },
      /* поделиться текстом */
      web_app_share: function (src, type, n, d) { share(src, type, n, d, false); },
      web_app_max_share: function (src, type, n, d) { share(src, type, n, d, true); },
      /* скачать файл */
      web_app_download_file: function (src, type, n, d) {
        var u = safeUrl(d.url);
        if (!u || u.indexOf('https:') !== 0) return fail(src, type, n, d, 'invalid_request');
        var name = String(d.file_name || d.fileName || '') || ('webapp_' + Date.now());
        if (!ask('download', 'Мини-приложение хочет скачать файл «' + cut(name, 80) + '» с ' + hostOf(u) + '.\n\nСкачать?')) return ok(src, type, d, 'cancelled');
        var a = document.createElement('a'); a.href = u; a.download = name; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        ok(src, type, d, 'success');
      },
      /* тактильный отклик (данных наружу не отдаёт — без подтверждения) */
      web_app_haptic_feedback_impact: function (src, type, n, d) {
        var s = String(d.impactStyle || ''); vib(s === 'heavy' || s === 'rigid' ? 35 : s === 'medium' ? 20 : 10); ok(src, type, d, 'impactOccured');
      },
      web_app_haptic_feedback_notification: function (src, type, n, d) {
        vib(d.notificationType === 'error' ? [40, 40, 40] : [15, 40, 15]); ok(src, type, d, 'notificationOccured');
      },
      web_app_haptic_feedback_selection_change: function (src, type, n, d) { vib(8); ok(src, type, d, 'selectionChanged'); },
      /* справочные ответы */
      web_app_get_launch_context: function (src, type, n, d) { var o = { entryPoint: 'web_app' }; if (rid(d)) o.requestId = rid(d); reply(src, type, o); },
      web_app_get_viewport_size: function (src, type, n, d) {
        var el = frameEl(src), o = { height: Math.round(el ? el.clientHeight : window.innerHeight), width: Math.round(el ? el.clientWidth : window.innerWidth), isStateStable: true };
        if (rid(d)) o.requestId = rid(d); reply(src, type, o);
      },
      web_app_setup_screen_capture_behavior: function (src, type, n, d) { var o = { isScreenCaptureEnabled: d.isScreenCaptureEnabled === true }; if (rid(d)) o.requestId = rid(d); reply(src, type, o); },
      web_app_nfc_get_info: function (src, type, n, d) { var o = { available: false, enabled: false }; if (rid(d)) o.requestId = rid(d); reply(src, type, o); }
    };
    H.web_app_open_link = H.web_app_open_max_link;   /* у Web K open_link молча не работает (пустой web_app_allowed_protocols) */
    ['web_app_change_screen_brightness', 'web_app_nfc_emulate_nfc_tag', 'web_app_nfc_open_system_settings', 'web_app_open_code_reader', 'web_app_verify_mobile_id'].forEach(function (k) {
      H[k] = function (src, type, n, d) { fail(src, type, n, d, 'not_supported'); };
    });

    function share(src, type, n, d, toChat) {
      var txt = shareText(d);
      if (!txt) return fail(src, type, n, d, 'invalid_request');
      var q = 'Мини-приложение хочет поделиться:\n\n«' + cut(txt, 300) + '»\n\n' + (toChat ? 'Скопировать текст, чтобы отправить его в нужный чат?' : 'Открыть меню «Поделиться»?');
      if (!ask('share', q)) return ok(src, type, d, 'cancelled');
      if (toChat) {   /* в Komet тут выбор чата и отправка; в Web K выбора чата из этого кода нет — отдаём текст через буфер */
        copy(txt, 'Текст'); return ok(src, type, d, 'cancelled');
      }
      var done = function () { ok(src, type, d, 'shared'); };
      if (navigator.share) {
        navigator.share({ text: txt }).then(done, function (e) {
          if (e && e.name === 'AbortError') return ok(src, type, d, 'cancelled');
          copy(txt, 'Текст'); done();
        });
      } else { copy(txt, 'Текст'); done(); }
    }

    function onMessage(ev) {
      if (ev.__mxWa || !isAppFrame(ev.source)) return;
      var m = parse(ev.data); if (!m) return;
      var n = norm(m.type), h = H[n];
      if (h) {
        ev.stopImmediatePropagation();   /* у Web K для этих имён другая (Telegram) семантика */
        try { h(ev.source, m.type, n, m.data); } catch (e) { fail(ev.source, m.type, n, m.data, 'request_error'); }
        return;
      }
      /* незнакомое имя в стиле Komet (WebAppXxx): Web K его не понимает — отвечаем ошибкой, как Komet */
      if (/^WebApp[A-Z]/.test(m.type) && !SILENT[m.type]) fail(ev.source, m.type, n, m.data, 'unsupported_method');
    }
    /* Нативное окно мини-приложения (MiniAppWindow.kt): WebViewHandler.postEvent приходит сюда; ответы идут через AndroidMiniAppWin.deliver. */
    window.__mxWinEvent = function (winId, name, raw, botId) {
      var d = {}; try { d = JSON.parse(raw || '{}') || {}; } catch (e) { }
      var src = {
        __botId: botId,
        postMessage: function (json) {
          try { var m = JSON.parse(json); window.AndroidMiniAppWin.deliver(winId, m.eventType, JSON.stringify(m.eventData || {})); } catch (e) { }
        }
      };
      var n = norm(name), h = H[n];
      try {
        if (h) h(src, name, n, d);
        else if (/^WebApp[A-Z]/.test(name) && !SILENT[name]) fail(src, name, n, d, 'unsupported_method');
      } catch (e) { fail(src, name, n, d, 'request_error'); }
    };
    window.addEventListener('message', onMessage, true);
    return { norm: norm, parse: parse, handlers: H };
  })();
  /* Возврат из внешнего сценария (Цифровой ID и т.п.): APK перехватывает переход на адрес с externalCallback=1 (как web_app_screen.dart в Komet)
     и вызывает эту функцию. Дальше: opcode 105 -> opcode 160 -> окно мини-приложения перезагружается новым адресом. */
  /* «Сферум» и «Цифровой ID» — мини-приложения; их id приходят в конфиге входа (воркер: __mxNoteConfig), как в Komet (fetchSferum / fetchDigitalId) */
  function launchMini(id, title) {   /* id → web-app-init → нативное окно (APK, как в Komet) или iframe-оверлей */
    return jpost('/api/web-app-init', { botId: id }).then(function (r) {
      if (!r || !r.url) throw new Error('сервер не вернул адрес приложения');
      if (window.AndroidMiniAppWin && window.AndroidMiniAppWin.open) { window.AndroidMiniAppWin.open(r.url, title, Number(id) || 0); return; }
      miniHost(r.url);
      appOverlay(r.url);
    });
  }
  function entryIconName(icon) {   /* https://st.max.ru/icons/sferum_with_padding.png → «sferum with padding» */
    var n = String(icon || '').split('?')[0].split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    return n || 'без названия';
  }
  function openEntryApp(key, title) {
    toast('Открываем «' + title + '»…');
    var KEY = 'mx_entry_apps';
    rpc('entryApps').then(function (e) {
      var saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (x) { }
      var cur = {}; if (e && e.sferum) cur.sferum = e.sferum; if (e && e.digital) cur.digital = e.digital;
      if (cur.sferum || cur.digital) { try { localStorage.setItem(KEY, JSON.stringify(Object.assign(saved, cur))); } catch (x) { } }   /* запоминаем: после перезапуска воркера конфиг приходит не сразу */
      var id = cur[key] || saved[key];
      if (!id) throw new Error(e && e.banners
        ? 'в конфиге аккаунта нет такого приложения. «Другие сервисы» покажут всё, что пришло'
        : 'конфиг ещё не получен, переподключитесь и попробуйте снова');
      return launchMini(id, title);
    }).catch(function (e) { toast(title + ': ' + (e && e.message || e)); });
  }
  function appOverlay(url) {
    var old = document.getElementById('mx-wa-overlay'); if (old) old.remove();
    var box = document.createElement('div'), L = null; box.id = 'mx-wa-overlay';
    function close() { if (L) { var q = L; L = null; layerRelease(q); } box.remove(); }
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#0f1216;display:flex;flex-direction:column';
    var bar = document.createElement('div'); bar.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:8px';
    var x = document.createElement('button'); x.textContent = 'Закрыть';
    x.style.cssText = 'padding:8px 14px;border:0;border-radius:10px;background:#3a4452;color:#fff;font-size:14px';
    x.onclick = close;
    var out = document.createElement('button'); out.textContent = 'Снаружи'; out.style.cssText = x.style.cssText;
    out.onclick = function () { window.open(url, '_blank', 'noopener'); };
    var f = document.createElement('iframe'); f.src = url; f.style.cssText = 'flex:1;border:0;width:100%'; f.setAttribute('allow', 'clipboard-write');
    bar.appendChild(out); bar.appendChild(x); box.appendChild(bar); box.appendChild(f); document.body.appendChild(box);
    L = layerPush(function () { L = null; box.remove(); }, false);
  }
  window.__mxExternalCallback = function (url) {
    var ok = false; try { ok = new URL(url).searchParams.get('externalCallback') === '1'; } catch (e) { }
    if (!ok) return;
    toast('Завершаем вход…');
    jpost('/api/external-callback', { url: url }).then(function (r) {
      if (!r || !r.url) throw new Error('сервер не вернул адрес');
      try { if (window.AndroidMiniAppWin && window.AndroidMiniAppWin.isOpen && window.AndroidMiniAppWin.isOpen()) { window.AndroidMiniAppWin.reload(r.url); return; } } catch (e) { }
      var fr = document.getElementsByTagName('iframe'), target = null;
      for (var i = 0; i < fr.length; i++) {
        var h = ''; try { h = new URL(fr[i].src).hostname; } catch (e) { }
        if (h && h !== '127.0.0.1' && h !== 'localhost') target = fr[i];   /* окно мини-приложения (не наш legacy-iframe) */
      }
      if (target) target.src = r.url; else appOverlay(r.url);
    }, function (e) { toast('Не удалось завершить вход: ' + (e && e.message || e)); });
  };
  window.__mxUi = { open: open, closeAll: closeAll, rpc: rpc, screens: S };
})();
