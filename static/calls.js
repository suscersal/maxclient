/* Звонки MAX 1:1 (аудио): сигнализация ws2 + WebRTC + экран звонка.
 * Порядок и поля — по Komet: lib/core/calls/call_session.dart, ws2_signaling.dart,
 * call_controller.dart. Серверная часть — bridge.py (блок «Звонки»): /api/call/start,
 * /api/call/events (SSE, входящие), /call-ws (мост к ws2).
 * Не покрыто: группы/конференции (topology SERVER, SFU), камера и демонстрация экрана.
 *
 * Подключается и в классическом UI, и в /tg/. API: MaxCalls.start(peerId, {name, avatarUrl}),
 * MaxCalls.setResolver(id => ({name, avatarUrl})), MaxCalls.isBusy(). */
(function () {
  'use strict';
  if (window.MaxCalls) return;

  var CAPS = '3c02f'; // Ws2Config.defaultCapabilities
  var RING_TIMEOUT_MS = 45000;
  var resolver = null;
  var cur = null; // активная сессия
  var pending = null; // входящий, ещё не принятый
  var ringTimer = null, ringCtx = null, ringBeat = null;
  var bc = null;
  try { bc = new BroadcastChannel('maxclient_calls'); } catch (e) { /* нет BroadcastChannel */ }

  function noop() {}
  function log() { try { console.log.apply(console, ['[call]'].concat([].slice.call(arguments))); } catch (e) { /* */ } }

  function jpost(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          return d;
        });
      });
  }

  function peerInfo(id, hint) {
    var r = null;
    try { r = resolver && resolver(id); } catch (e) { /* */ }
    if (r && typeof r.then === 'function') r = null; // асинхронный ответ подтянет lateResolve
    r = r || {};
    return {
      id: id,
      name: (hint && hint.name) || r.name || ('Контакт #' + id),
      avatarUrl: (hint && hint.avatarUrl) || r.avatarUrl || null
    };
  }

  // резолвер вернул Promise (/tg/: имя и фото приходят через rpc) — обновим экран, когда придёт
  function lateResolve(id, apply) {
    try {
      var r = resolver && resolver(id);
      if (r && typeof r.then === 'function') r.then(function (x) { if (x) apply(x); }).catch(noop);
    } catch (e) { /* */ }
  }

  // Текст ошибки по e.name: NotAllowedError — нет разрешения, NotReadableError — разрешение
  // есть, но систему не удалось открыть микрофон (занят другим приложением, закрыт
  // AppOps/«Конфиденциальностью» прошивки, не освободился после прошлого звонка).
  function micError(e) {
    var n = e && e.name ? e.name : '';
    var msg;
    if (n === 'NotReadableError') {
      msg = 'Микрофон занят другим приложением или закрыт настройками системы';
    } else if (n === 'NotAllowedError' || n === 'SecurityError') {
      msg = 'Нет разрешения на микрофон: включите его в настройках приложения';
    } else if (n === 'NotFoundError' || n === 'OverconstrainedError') {
      msg = 'Микрофон не найден';
    } else {
      msg = 'Нет доступа к микрофону';
    }
    return new Error(msg + (n ? ' (' + n + ')' : ''));
  }

  function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('Микрофон недоступен: нужен https или localhost'));
    }
    var gum = function (audio) { return navigator.mediaDevices.getUserMedia({ audio: audio }); };
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var denied = function (e) { return e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'); };
    return gum({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 })
      .catch(function (e) {
        if (denied(e)) throw e; // повтор ничего не изменит
        // часть прошивок/WebView не открывает микрофон с расширенными ограничениями
        log('getUserMedia с ограничениями не удался:', e && e.name, '— пробуем audio: true');
        return gum(true).catch(function (e2) {
          if (!e2 || e2.name !== 'NotReadableError') throw e2;
          // микрофон мог ещё не освободиться после прошлого звонка/записи
          return wait(700).then(function () { return gum(true); });
        });
      })
      .catch(function (e) { throw micError(e); });
  }

  // ICE из notification connection: conversationParams.{stun,turn} (Komet _iceServersFrom)
  function iceFrom(cp) {
    if (!cp || typeof cp !== 'object') return null;
    var out = [];
    if (cp.stun && cp.stun.urls) out.push({ urls: cp.stun.urls });
    if (cp.turn && cp.turn.urls) {
      var s = { urls: cp.turn.urls };
      if (cp.turn.username) s.username = cp.turn.username;
      if (cp.turn.credential) s.credential = cp.turn.credential;
      out.push(s);
    }
    return out.length ? out : null;
  }

  /* ---------------------------------------------------------------- сессия */

  function Session(o) {
    this.role = o.role; // 'caller' | 'callee'
    this.key = o.callKey;
    this.uid = o.userId;
    this.ice = o.iceServers || [];
    this.peer = o.peer;
    this.stream = o.stream || null;
    this.seq = 0;
    this.waiters = {};
    this.state = 'connecting'; // connecting | ringing | active | ended
    this.accepted = false;
    this.ended = false;
    this.muted = false;
    this.gotConn = false;
    this.pc = null;
    this.peerId = null; this.peerType = 'USER'; this.peerDev = 0;
    this.remoteSet = false; this.cands = []; this.early = [];
    this.iceRestarts = 0;
    this.tail = Promise.resolve();
    this.t0 = 0;
  }

  Session.prototype.open = function () {
    var self = this;
    return new Promise(function (res, rej) {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      var ws = self.ws = new WebSocket(proto + location.host + '/call-ws?k=' + encodeURIComponent(self.key));
      var opened = false;
      ws.onopen = function () { opened = true; res(); };
      ws.onmessage = function (e) { self.onFrame(e.data); };
      ws.onerror = function () { if (!opened) rej(new Error('Нет связи с сервером звонков')); };
      ws.onclose = function () {
        if (!opened) rej(new Error('Сервер звонков закрыл соединение'));
        else self.end('Соединение с сервером звонков потеряно');
      };
    });
  };

  Session.prototype.cmd = function (command, extra, timeout) {
    var self = this, seq = ++this.seq;
    var obj = Object.assign({}, extra || {}, { command: command, sequence: seq });
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { delete self.waiters[seq]; rej(new Error(command + ': таймаут')); }, timeout || 15000);
      self.waiters[seq] = {
        res: function (v) { clearTimeout(t); res(v); },
        rej: function (e) { clearTimeout(t); rej(e); }
      };
      try { self.ws.send(JSON.stringify(obj)); } catch (e) { clearTimeout(t); delete self.waiters[seq]; rej(e); }
    });
  };

  Session.prototype.onFrame = function (text) {
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'proxy-error') { this.end('Сервер звонков недоступен'); return; }
    var w = m.sequence != null ? this.waiters[m.sequence] : null;
    if ((m.type === 'response' || m.type === 'error') && w) {
      delete this.waiters[m.sequence];
      if (m.type === 'error' || m.error) w.rej(new Error(command_error(m))); else w.res(m);
    }
    if (m.type === 'error') {
      log('ws2 error', m);
      if (m.error === 'conversation-ended') this.end('Звонок завершён');
      return;
    }
    if (m.type === 'notification' || m.notification) {
      var self = this;
      // Komet обрабатывает нотификации строго по очереди (_enqueue)
      this.tail = this.tail.then(function () { return self.onNotif(m); })
        .catch(function (e) { log('handler failed', m.notification, e); });
    }
  };
  function command_error(m) { return String(m.error && m.error.message || m.error || 'ошибка ws2'); }

  Session.prototype.onNotif = function (m) {
    log('ws2 <-', m.notification);
    switch (m.notification) {
      case 'connection': return this.onConnection(m);
      case 'transmitted-data': return this.onTransmitted(m);
      case 'accepted-call': this.setState('active'); break;
      case 'media-settings-changed':
        if (m.mediaSettings && m.mediaSettings.isAudioEnabled === false) ui.note('Собеседник выключил микрофон');
        else ui.note('');
        break;
      case 'hungup':
        // как в Komet: своё id — конец звонка; чужое — только убрать участника (дальше придёт closed-conversation)
        if (m.participantId === this.uid) this.end('Звонок завершён');
        break;
      case 'closed-conversation': this.end('Звонок завершён'); break;
    }
  };

  Session.prototype.resolvePeer = function (conversation) {
    var ps = conversation && conversation.participants;
    if (!Array.isArray(ps)) return;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p && typeof p.id === 'number' && p.id !== this.uid) {
        this.peerId = p.id;
        if (Array.isArray(p.responderTypes) && p.responderTypes.length) this.peerType = String(p.responderTypes[0]);
        if (Array.isArray(p.responderDeviceIdxs) && typeof p.responderDeviceIdxs[0] === 'number') this.peerDev = p.responderDeviceIdxs[0];
        break;
      }
    }
  };

  Session.prototype.onConnection = function (m) {
    var self = this;
    this.gotConn = true;
    clearTimeout(this.wakeT);
    this.ice = iceFrom(m.conversationParams) || this.ice;
    this.resolvePeer(m.conversation);
    var topo = m.conversation && m.conversation.topology;
    log('connection role=' + this.role + ' peer=' + this.peerId + ' topology=' + topo);
    if (topo === 'SERVER') { // SFU (группа) — в клиенте не реализован
      return this.cmd('hangup', { reason: 'HUNGUP' }, 4000).catch(noop).then(function () { self.end('Групповые звонки пока не поддерживаются'); });
    }
    var pc = this.pc = new RTCPeerConnection({
      iceServers: this.ice, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require'
    });
    pc.onicecandidate = function (e) { if (e.candidate) self.sendCandidate(e.candidate); };
    pc.ontrack = function (e) { ui.attachRemote(e); };
    pc.onconnectionstatechange = function () {
      log('pc', pc.connectionState);
      if (pc.connectionState === 'connected') { self.setState('active'); }
      else if (pc.connectionState === 'failed') self.restartIce();
      else if (pc.connectionState === 'closed') self.end('Звонок завершён');
    };
    this.stream.getTracks().forEach(function (t) { pc.addTrack(t, self.stream); });
    // Komet всегда добавляет recvonly-видео: без него SDP расходится с мобильным клиентом
    pc.addTransceiver('video', { direction: 'recvonly' });
    var p = Promise.resolve();
    if (this.role === 'caller') {
      this.setState('ringing');
      p = this.sendOffer(false);
    }
    return p.then(function () { return self.accept(self.role !== 'caller'); }).then(function () {
      var early = self.early; self.early = [];
      return early.reduce(function (a, em) { return a.then(function () { return self.onTransmitted(em); }); }, Promise.resolve());
    });
  };

  Session.prototype.sendSdp = function (type, sdp) {
    return this.cmd('transmit-data', {
      participantId: this.peerId, participantType: this.peerType, deviceIdx: this.peerDev,
      data: { sdp: { type: type, sdp: sdp } }, capabilities: CAPS
    });
  };

  Session.prototype.sendOffer = function (iceRestart) {
    var self = this, pc = this.pc;
    if (!pc || this.peerId == null) return Promise.resolve();
    return pc.createOffer(iceRestart ? { iceRestart: true } : undefined).then(function (offer) {
      return pc.setLocalDescription(offer).then(function () { return self.sendSdp('offer', offer.sdp); });
    });
  };

  Session.prototype.sendCandidate = function (c) {
    if (this.peerId == null) return;
    this.cmd('transmit-data', {
      participantId: this.peerId, participantType: this.peerType, deviceIdx: this.peerDev,
      data: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid || '0', sdpMLineIndex: c.sdpMLineIndex || 0 } }
    }).catch(noop);
  };

  Session.prototype.onTransmitted = function (m) {
    var self = this, pc = this.pc, d = m.data;
    if (!d || typeof d !== 'object') return Promise.resolve();
    if (!pc) { this.early.push(m); return Promise.resolve(); } // оффер мог прийти раньше нашего connection
    if (d.sdp && d.sdp.sdp) {
      var type = d.sdp.type;
      if (type === 'answer' && pc.signalingState !== 'have-local-offer') return Promise.resolve();
      var pre = Promise.resolve();
      if (type === 'offer' && pc.signalingState === 'have-local-offer') {
        log('offer glare, rollback');
        pre = pc.setLocalDescription({ type: 'rollback' });
      }
      return pre.then(function () { return pc.setRemoteDescription({ type: type, sdp: d.sdp.sdp }); }).then(function () {
        self.remoteSet = true;
        var c = self.cands; self.cands = [];
        c.forEach(function (x) { pc.addIceCandidate(x).catch(noop); });
        if (type !== 'offer') return;
        return pc.createAnswer().then(function (a) {
          return pc.setLocalDescription(a).then(function () { return self.sendSdp('answer', a.sdp); });
        }).then(function () { if (self.state === 'connecting') self.setState('ringing'); });
      });
    }
    if (d.candidate && d.candidate.candidate != null) {
      var ice = { candidate: d.candidate.candidate, sdpMid: d.candidate.sdpMid, sdpMLineIndex: d.candidate.sdpMLineIndex };
      if (this.remoteSet) pc.addIceCandidate(ice).catch(noop); else this.cands.push(ice);
    }
    return Promise.resolve();
  };

  Session.prototype.restartIce = function () {
    if (this.ended || this.iceRestarts >= 6) { this.end('Связь потеряна'); return; }
    this.iceRestarts++;
    this.setState('connecting');
    this.cands = [];
    this.sendOffer(true).catch(noop);
  };

  Session.prototype.accept = function (activate) {
    var self = this;
    if (this.accepted) return Promise.resolve();
    this.accepted = true;
    return this.cmd('accept-call', {
      mediaSettings: { isVideoEnabled: false, isAudioEnabled: !this.muted, isScreenSharingEnabled: false, isAnimojiEnabled: false }
    }).then(function () { if (activate && self.pc && self.pc.connectionState === 'connected') self.setState('active'); });
  };

  // ws2 после рукопожатия обычно сам шлёт connection; если нет — будим тем же способом, что Komet
  Session.prototype.armWake = function () {
    var self = this;
    this.wakeT = setTimeout(function () {
      if (self.ended || self.gotConn) return;
      log('connection не пришла за 1.2 с — change-media-settings');
      self.cmd('change-media-settings', { mediaSettings: { isVideoEnabled: false, isAudioEnabled: !self.muted, isScreenSharingEnabled: false, isAnimojiEnabled: false } })
        .catch(noop);
      self.wakeT = setTimeout(function () {
        if (self.ended || self.gotConn) return;
        log('всё ещё тихо — accept-call вслепую');
        self.accept(false).catch(noop);
      }, 1200);
    }, 1200);
    this.connT = setTimeout(function () {
      if (!self.ended && !self.gotConn) self.end('Нет ответа сервера звонков');
    }, 20000);
  };

  Session.prototype.setState = function (s) {
    if (this.ended || this.state === s) return;
    this.state = s;
    if (s === 'active') { this.t0 = Date.now(); clearTimeout(this.connT); }
    ui.render();
  };

  Session.prototype.setMuted = function (muted) {
    this.muted = muted;
    if (this.stream) this.stream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
    this.cmd('change-media-settings', { mediaSettings: { isVideoEnabled: false, isAudioEnabled: !muted, isScreenSharingEnabled: false, isAnimojiEnabled: false } }).catch(noop);
    ui.render();
  };

  Session.prototype.autoReason = function () {
    if (this.state !== 'active') {
      if (this.role === 'caller') return 'CANCELED';
      if (this.role === 'callee' && !this.accepted) return 'REJECTED';
    }
    return 'HUNGUP';
  };

  Session.prototype.hangup = function (reason) {
    var self = this;
    return this.cmd('hangup', { reason: reason || this.autoReason() }, 4000).catch(noop).then(function () { self.end('Звонок завершён'); });
  };

  Session.prototype.end = function (why) {
    if (this.ended) return;
    this.ended = true;
    this.state = 'ended';
    clearTimeout(this.wakeT); clearTimeout(this.connT);
    try { if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* */ }
    try { if (this.pc) this.pc.close(); } catch (e) { /* */ }
    try { if (this.ws) { this.ws.onclose = null; this.ws.close(); } } catch (e) { /* */ }
    Object.keys(this.waiters).forEach(function (k) { this.waiters[k].rej(new Error('закрыто')); }, this);
    if (cur === this) cur = null;
    ui.finish(why || 'Звонок завершён');
  };

  /* ----------------------------------------------------------------- рингтон */

  function beep() {
    if (!ringCtx) return;
    try {
      [440, 480].forEach(function (f) {
        var o = ringCtx.createOscillator(), g = ringCtx.createGain();
        o.frequency.value = f; g.gain.value = 0.06;
        o.connect(g); g.connect(ringCtx.destination);
        o.start(); o.stop(ringCtx.currentTime + 0.5);
      });
    } catch (e) { /* */ }
  }
  function startRing() {
    stopRing();
    try {
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (ringCtx.resume) ringCtx.resume().catch(noop);
      beep(); ringBeat = setInterval(beep, 2000);
    } catch (e) { /* автоплей заблокирован — остаётся визуальный сигнал */ }
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400]); } catch (e) { /* */ }
  }
  function stopRing() {
    clearInterval(ringBeat); ringBeat = null;
    try { if (ringCtx) ringCtx.close(); } catch (e) { /* */ }
    ringCtx = null;
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) { /* */ }
  }

  /* ---------------------------------------------------------------------- UI */

  var ui = (function () {
    var root, el = {}, tick = null, hideT = null, built = false;
    var api = null, qT = null, qPrev = { lost: 0, recv: 0, conc: 0, tot: 0 };
    /* Пока виден экран звонка, системная «Назад» не должна уходить по истории Web K (раньше закрывала чат под звонком).
       Слой из mx-ui.js (/tg/) поглощает «Назад» и подсказывает, как выйти; в классическом UI __mxBackLayer нет — ничего не делаем. */
    var guardRel = null;
    function guardOn() {
      if (guardRel || typeof window.__mxBackLayer !== 'function') return;
      guardRel = window.__mxBackLayer(function () {
        guardRel = null; guardOn();
        if (el.note) { el.note.textContent = 'Чтобы выйти, завершите звонок'; setTimeout(function () { if (el.note && el.note.textContent === 'Чтобы выйти, завершите звонок') el.note.textContent = ''; }, 2500); }
      });
    }
    function guardOff() { if (guardRel) { var r = guardRel; guardRel = null; try { r(); } catch (e) { /* */ } } }
    var sheetOpen = false, remote = null, actx = null, bnodes = null, sinks = [], sinkIdx = 0;
    function lsGet(k, d) { try { var v = localStorage.getItem('maxclient_call_' + k); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem('maxclient_call_' + k, String(v)); } catch (e) { /* */ } }
    var volume = Math.min(1, Math.max(0, parseFloat(lsGet('vol', '1')) || 1)), boost = lsGet('boost', '0') === '1';

    // Громкость собеседника: 0–100% через audio.volume; «усиление» — Web Audio (×2.2 + компрессор, чтобы не хрипело)
    function applyAudio() {
      if (!el.audio) return;
      el.audio.volume = volume;
      if (boost && remote) {
        try {
          if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
          if (actx.resume) actx.resume().catch(noop);
          if (!bnodes || bnodes.stream !== remote) {
            dropBoost();
            var src = actx.createMediaStreamSource(remote), g = actx.createGain(), c = actx.createDynamicsCompressor();
            src.connect(g); g.connect(c); c.connect(actx.destination);
            bnodes = { stream: remote, src: src, g: g, c: c };
          }
          bnodes.g.gain.value = 2.2 * volume;
          el.audio.muted = true; // звук идёт через Web Audio; элемент нужен, чтобы Chrome отдавал поток
          return;
        } catch (e) { log('усиление не включилось', e && e.message); boost = false; lsSet('boost', 0); }
      }
      dropBoost();
      el.audio.muted = false;
    }
    function dropBoost() {
      if (!bnodes) return;
      try { bnodes.src.disconnect(); bnodes.g.disconnect(); bnodes.c.disconnect(); } catch (e) { /* */ }
      bnodes = null;
    }
    function loadSinks() {
      if (!el.audio || !el.audio.setSinkId || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices.enumerateDevices().then(function (d) {
        sinks = d.filter(function (x) { return x.kind === 'audiooutput'; });
        if (cur && root && !root.hidden) api.render();
      }).catch(noop);
    }
    function cycleSink() {
      if (sinks.length < 2) return;
      sinkIdx = (sinkIdx + 1) % sinks.length;
      var d = sinks[sinkIdx], name = d.label || ('устройство ' + (sinkIdx + 1));
      el.audio.setSinkId(d.deviceId).then(function () {
        if (actx && actx.setSinkId) actx.setSinkId(d.deviceId).catch(noop);
        api.note('Вывод: ' + name); setTimeout(function () { api.note(''); }, 3000);
      }).catch(function (e) { log('setSinkId', e && e.message); api.note('Не удалось сменить вывод'); });
    }

    // Качество связи по getStats: потери, джиттер, «скрытые» семплы (рваный/роботный голос), RTT
    function pollQ() {
      var s = cur;
      if (!s || !s.pc || s.state !== 'active' || !el.q) { if (el.q) el.q.textContent = ''; return; }
      s.pc.getStats().then(function (rep) {
        var lost = 0, recv = 0, jit = 0, conc = 0, tot = 0, rtt = null;
        rep.forEach(function (r) {
          if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio') {
            lost = r.packetsLost || 0; recv = r.packetsReceived || 0; jit = (r.jitter || 0) * 1000;
            conc = r.concealedSamples || 0; tot = r.totalSamplesReceived || 0;
          }
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
        });
        var dl = Math.max(0, lost - qPrev.lost), dr = Math.max(0, recv - qPrev.recv);
        var dc = Math.max(0, conc - qPrev.conc), dt = Math.max(0, tot - qPrev.tot);
        qPrev = { lost: lost, recv: recv, conc: conc, tot: tot };
        var loss = dl + dr > 0 ? dl / (dl + dr) * 100 : 0, cp = dt > 0 ? dc / dt * 100 : 0;
        var bad = loss > 8 || jit > 80 || cp > 15 || (rtt != null && rtt > 500);
        var mid = loss > 2 || jit > 40 || cp > 5 || (rtt != null && rtt > 250);
        var lvl = bad ? 'плохая' : mid ? 'средняя' : 'хорошая';
        el.q.textContent = 'Связь: ' + lvl + ' · потери ' + loss.toFixed(0) + '% · рвётся ' + cp.toFixed(0) + '% · джиттер ' + jit.toFixed(0) + ' мс' + (rtt != null ? ' · ' + rtt.toFixed(0) + ' мс' : '');
        el.q.className = 'mxc-q' + (bad || mid ? ' bad' : '');
        if (bad || mid) log('quality', lvl, 'loss%', loss.toFixed(1), 'conceal%', cp.toFixed(1), 'jitter', jit.toFixed(0), 'rtt', rtt);
      }).catch(noop);
    }

    function renderSheet() {
      if (!el.sheet) return;
      el.sheet.textContent = '';
      el.sheet.hidden = !sheetOpen;
      if (!sheetOpen) return;
      var lab = document.createElement('label');
      var t = document.createElement('span'); t.textContent = 'Громкость собеседника';
      var v = document.createElement('span'); v.textContent = Math.round(volume * 100) + '%';
      lab.appendChild(t); lab.appendChild(v);
      var r = document.createElement('input'); r.type = 'range'; r.min = 0; r.max = 100; r.step = 5; r.value = Math.round(volume * 100);
      r.oninput = function () { volume = r.value / 100; v.textContent = r.value + '%'; lsSet('vol', volume); applyAudio(); };
      var chip = document.createElement('button'); chip.type = 'button'; chip.className = 'mxc-chip' + (boost ? ' on' : '');
      chip.textContent = boost ? 'Усиление ×2 включено' : 'Усилить звук ×2';
      chip.onclick = function () {
        boost = !boost; lsSet('boost', boost ? 1 : 0); applyAudio();
        chip.className = 'mxc-chip' + (boost ? ' on' : ''); chip.textContent = boost ? 'Усиление ×2 включено' : 'Усилить звук ×2';
      };
      var h = document.createElement('div'); h.className = 'mxc-hint';
      h.textContent = 'Если голос тихий или глухой — включите усиление. Строка «Связь» выше показывает, рвётся ли звук по сети.';
      el.sheet.appendChild(lab); el.sheet.appendChild(r); el.sheet.appendChild(chip); el.sheet.appendChild(h);
    }

    function build() {
      if (built) return;
      built = true;
      var st = document.createElement('style');
      st.textContent =
        '.mxc{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(10,12,16,.92);color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
        '.mxc[hidden]{display:none}.mxc-card{width:min(92vw,340px);text-align:center;padding:24px 16px}' +
        '.mxc-ava{width:112px;height:112px;border-radius:50%;margin:0 auto 18px;background:#3a4452;display:flex;' +
        'align-items:center;justify-content:center;font-size:44px;font-weight:600;overflow:hidden}' +
        '.mxc-ava img{width:100%;height:100%;object-fit:cover}.mxc-name{font-size:24px;font-weight:600;word-break:break-word}' +
        '.mxc-status{margin-top:8px;font-size:16px;color:#aab3bf;min-height:22px}.mxc-note{margin-top:4px;font-size:13px;color:#f0b44c;min-height:18px}' +
        '.mxc-btns{display:flex;gap:28px;justify-content:center;margin-top:44px}.mxc-b{border:0;border-radius:50%;width:68px;height:68px;' +
        'font-size:26px;color:#fff;cursor:pointer;background:#3a4452}.mxc-b.on{background:#fff;color:#1b1f26}' +
        '.mxc-b.red{background:#e5484d}.mxc-b.green{background:#30a46c}.mxc-l{display:block;font-size:12px;margin-top:6px;color:#aab3bf}' +
        '.mxc-w{display:flex;flex-direction:column;align-items:center}' +
        '.mxc-card{width:min(94vw,360px)}.mxc-btns{gap:22px;margin-top:36px}.mxc-b.big{width:76px;height:76px;font-size:30px}' +
        '.mxc-end{display:flex;justify-content:center;margin-top:28px}.mxc-end:empty{display:none}' +
        '.mxc-q{margin-top:6px;font-size:12px;color:#8f99a6;min-height:16px}.mxc-q.bad{color:#f0b44c}' +
        '.mxc-sheet{margin:22px auto 0;padding:14px;border-radius:16px;background:#1f252d;text-align:left}.mxc-sheet[hidden]{display:none}' +
        '.mxc-sheet label{display:flex;justify-content:space-between;font-size:13px;color:#aab3bf}' +
        '.mxc-sheet input[type=range]{width:100%;margin:12px 0 8px}' +
        '.mxc-chip{border:0;border-radius:14px;padding:8px 12px;background:#3a4452;color:#fff;font-size:13px;cursor:pointer}' +
        '.mxc-chip.on{background:#fff;color:#1b1f26}.mxc-hint{margin-top:8px;font-size:12px;color:#8f99a6}';
      document.head.appendChild(st);
      root = document.createElement('div');
      root.className = 'mxc'; root.hidden = true;
      root.innerHTML = '<div class="mxc-card"><div class="mxc-ava"></div><div class="mxc-name"></div>' +
        '<div class="mxc-status"></div><div class="mxc-q"></div><div class="mxc-note"></div><div class="mxc-btns"></div>' +
        '<div class="mxc-sheet" hidden></div><div class="mxc-end"></div>' +
        '<audio autoplay playsinline></audio></div>';
      document.body.appendChild(root);
      el.ava = root.querySelector('.mxc-ava'); el.name = root.querySelector('.mxc-name');
      el.status = root.querySelector('.mxc-status'); el.note = root.querySelector('.mxc-note');
      el.btns = root.querySelector('.mxc-btns'); el.audio = root.querySelector('audio');
      el.q = root.querySelector('.mxc-q'); el.sheet = root.querySelector('.mxc-sheet'); el.end = root.querySelector('.mxc-end');
    }

    function btn(cls, icon, label, fn) {
      var w = document.createElement('div'); w.className = 'mxc-w';
      var b = document.createElement('button'); b.type = 'button'; b.className = 'mxc-b ' + cls; b.textContent = icon;
      b.onclick = fn;
      var l = document.createElement('span'); l.className = 'mxc-l'; l.textContent = label;
      w.appendChild(b); w.appendChild(l);
      return w;
    }

    function setPeer(peer) {
      el.name.textContent = peer.name;
      el.ava.textContent = '';
      if (peer.avatarUrl) {
        var img = document.createElement('img'); img.alt = ''; img.src = peer.avatarUrl;
        img.onerror = function () { el.ava.textContent = (peer.name || '?').trim().charAt(0).toUpperCase(); };
        el.ava.appendChild(img);
      } else {
        el.ava.textContent = (peer.name || '?').trim().charAt(0).toUpperCase();
      }
    }

    function fmt(ms) {
      var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
      return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }

    function paint() {
      if (!cur) return;
      var s = cur;
      el.status.textContent = s.state === 'active' ? fmt(Date.now() - s.t0)
        : s.state === 'ringing' ? (s.role === 'caller' ? 'Вызов…' : 'Соединение…') : 'Соединение…';
    }

    api = {
      showIncoming: function (ev, peer) {
        build(); clearTimeout(hideT);
        sheetOpen = false; el.sheet.hidden = true; el.end.textContent = ''; el.q.textContent = '';
        setPeer(peer);
        el.status.textContent = ev.isVideo ? 'Входящий видеозвонок (будет только звук)' : 'Входящий звонок';
        el.note.textContent = '';
        el.btns.textContent = '';
        el.btns.appendChild(btn('red', '✕', 'Отклонить', function () { MaxCalls.reject(); }));
        el.btns.appendChild(btn('green', '✆', 'Принять', function () { MaxCalls.accept(); }));
        root.hidden = false; guardOn();
      },
      setPeer: function (peer) { if (built) setPeer(peer); },
      showCall: function (peer) {
        build(); clearTimeout(hideT);
        setPeer(peer);
        root.hidden = false; guardOn();
        sheetOpen = false; qPrev = { lost: 0, recv: 0, conc: 0, tot: 0 };
        this.render();
        clearInterval(tick); tick = setInterval(paint, 500);
        clearInterval(qT); qT = setInterval(pollQ, 2000);
        loadSinks();
      },
      render: function () {
        if (!cur || !root) return;
        paint();
        el.btns.textContent = ''; el.end.textContent = '';
        var s = cur;
        el.btns.appendChild(btn(s.muted ? 'on' : '', s.muted ? '🔇' : '🎤', s.muted ? 'Включить' : 'Микрофон', function () { s.setMuted(!s.muted); }));
        el.btns.appendChild(btn(sheetOpen ? 'on' : '', '🔊', 'Звук', function () { sheetOpen = !sheetOpen; api.render(); }));
        if (sinks.length > 1) el.btns.appendChild(btn('', '🎧', 'Вывод', cycleSink));
        el.end.appendChild(btn('red big', '✕', s.state === 'active' ? 'Завершить' : 'Отмена', function () { s.hangup(); }));
        renderSheet();
      },
      note: function (t) { if (el.note) el.note.textContent = t || ''; },
      attachRemote: function (e) {
        build();
        var stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
        if (e.track.kind === 'audio') {
          remote = stream;
          el.audio.srcObject = stream;
          applyAudio();
          var p = el.audio.play(); if (p && p.catch) p.catch(noop);
        }
        // видео собеседника не показываем: свою камеру мы не отправляем, экрана для него в этом UI нет
      },
      finish: function (why) {
        clearInterval(tick); tick = null; clearInterval(qT); qT = null;
        guardOff();
        if (!root) return;
        if (el.audio) el.audio.srcObject = null;
        remote = null; dropBoost(); try { if (actx) actx.close(); } catch (e) { /* */ } actx = null;
        sheetOpen = false; el.sheet.hidden = true; el.q.textContent = ''; el.end.textContent = '';
        el.status.textContent = why; el.note.textContent = '';
        el.btns.textContent = '';
        clearTimeout(hideT);
        hideT = setTimeout(function () { if (!cur && !pending) root.hidden = true; }, 1800);
      },
      hide: function () { guardOff(); if (root) root.hidden = true; }
    };
    return api;
  })();

  /* ------------------------------------------------------------ публичный API */

  function dismissPending(broadcast) {
    if (!pending) return;
    var conv = pending.conversationId;
    clearTimeout(ringTimer); stopRing();
    pending = null;
    if (broadcast && bc) bc.postMessage({ t: 'handled', conv: conv });
  }

  function failUi(e) {
    log('error', e);
    ui.showCall({ name: 'Звонок', avatarUrl: null });
    ui.finish(e && e.message ? e.message : 'Не удалось начать звонок');
  }

  var MaxCalls = window.MaxCalls = {
    setResolver: function (fn) { resolver = fn; },
    isBusy: function () { return !!(cur || pending); },

    // Исходящий: микрофон (в жесте пользователя) -> op 78 -> ws2 -> offer после connection.
    start: function (peerId, opts) {
      opts = opts || {};
      if (cur || pending) return Promise.resolve(); // уже идёт звонок или звонят нам
      var peer = peerInfo(peerId, opts), stream;
      return getMic().then(function (s) {
        stream = s;
        return jpost('/api/call/start', { calleeId: peerId, isVideo: false });
      }).then(function (r) {
        var sess = cur = new Session({ role: 'caller', callKey: r.callKey, userId: r.userId, peer: peer, stream: stream });
        ui.showCall(peer);
        return sess.open().then(function () { sess.armWake(); });
      }).catch(function (e) {
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        if (cur) { var c = cur; cur = null; c.end(e.message); } else failUi(e);
      });
    },

    accept: function () {
      var ev = pending;
      if (!ev) return Promise.resolve();
      var peer = peerInfo(ev.callerId, ev.peerHint), stream;
      dismissPending(true);
      return getMic().then(function (s) {
        stream = s;
        var sess = cur = new Session({ role: 'callee', callKey: ev.callKey, userId: ev.userId, iceServers: ev.iceServers, peer: peer, stream: stream });
        ui.showCall(peer);
        return sess.open().then(function () {
          sess.armWake();
          // Komet: acceptIncoming = start() + accept() сразу после открытия сокета
          return sess.accept(false);
        });
      }).catch(function (e) {
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        if (cur) { var c = cur; cur = null; c.end(e.message); } else failUi(e);
      });
    },

    // Komet rejectIncoming: подключиться к ws2 и отправить hangup REJECTED
    reject: function () {
      var ev = pending;
      if (!ev) return Promise.resolve();
      dismissPending(true);
      ui.hide();
      var sess = new Session({ role: 'callee', callKey: ev.callKey, userId: ev.userId, peer: peerInfo(ev.callerId, null) });
      return sess.open().then(function () { return sess.cmd('hangup', { reason: 'REJECTED' }, 4000); })
        .catch(noop).then(function () { sess.ended = true; try { sess.ws.onclose = null; sess.ws.close(); } catch (e) { /* */ } });
    },

    hangup: function () { return cur ? cur.hangup() : Promise.resolve(); }
  };

  function onIncoming(ev) {
    if (cur || pending) return; // как _emitIncoming в Komet: во время звонка второй игнорируем
    pending = ev;
    var peer = peerInfo(ev.callerId, null);
    ui.showIncoming(ev, peer);
    lateResolve(ev.callerId, function (x) {
      ev.peerHint = { name: x.name, avatarUrl: x.avatarUrl };
      if (pending === ev) ui.setPeer(peerInfo(ev.callerId, ev.peerHint));
    });
    startRing();
    ringTimer = setTimeout(function () { dismissPending(true); ui.hide(); }, RING_TIMEOUT_MS);
    try {
      if (document.hidden && window.Notification && Notification.permission === 'granted') {
        new Notification('Входящий звонок', { body: peer.name, tag: 'maxcall' });
      }
    } catch (e) { /* */ }
  }

  function connectEvents() {
    if (!window.EventSource) return;
    var es = new EventSource('/api/call/events');
    es.onmessage = function (e) {
      var ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
      if (ev.type === 'incoming') onIncoming(ev);
      // запись звонка от того же абонента = звонок уже закончился (эвристика, формат отмены в Komet не найден)
      else if (ev.type === 'call_record' && pending && String(ev.sender) === String(pending.callerId)) { dismissPending(false); ui.hide(); }
    };
  }

  if (bc) bc.onmessage = function (e) {
    if (e.data && e.data.t === 'handled' && pending && pending.conversationId === e.data.conv) { dismissPending(false); ui.hide(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connectEvents);
  else connectEvents();
})();
