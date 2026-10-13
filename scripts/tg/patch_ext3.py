#!/usr/bin/env python3
"""Идемпотентно дополняет воркеры static/tg/index.worker-*.js расширением ext3.js:
вложения (фото/файлы/видео/голосовые/стикеры), закрепление чатов и сообщений, отправка фото/файлов.
Запускать ПОСЛЕ patch_ext2.py, из корня репо:
    python3 scripts/tg/patch_ext3.py
"""
import re, os, sys, glob
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EXT = open(os.path.join(HERE, 'ext3.js'), encoding='utf8').read()
B, E = '/* ==== MAX adapter ext3', '/* ==== конец ext3 ==== */'

def one(rx, s):
    m = re.search(rx, s)
    if not m: sys.exit('anchor not found: ' + rx)
    return m

for p in sorted(glob.glob(os.path.join(ROOT, 'static', 'tg', 'index.worker-*.js'))):
    s = open(p, encoding='utf8').read()
    ic = one(r'function \w+\(e\)\{(\w+)=e\}(?:var|const|let) \w+=\{_:`peerNotifySettings`', s).group(1)
    m = re.search(r'(\w+)=100,', s[:s.find('peerNotifySettings`')]); tc = m.group(1) if m else '100'
    nc = one(r'(?:,|let |var )(\w+)=1,(\w+)=1,' + ic + r';function', s).group(1)
    lc = one(r'(\w+)=\[\{_:`chat`,pFlags:\{\},id:5001', s).group(1)
    fc, pc, mc, Q = one(r'(\w+)=\{\},(\w+)=\{\},(\w+)=\{\};function (\w+)\(e,t,n,r,i,a=\{\}\)', s).groups()
    uc = one(r'(\w+)=e=>e\._===`inputPeerUser`\?`u`\+e\.user_id', s).group(1)
    ad = one(r'(\w+)=e=>e\[0\]===`u`\?\{_:`peerUser`,user_id:\+e\.slice\(1\)\}:\{_:`peerChat`,chat_id:\+e\.slice\(1\)\}', s).group(1)
    us = one(r'users\.getUsers`?"?:async e=>\(await __mxSync\(\),e\.id\|\|\[\]\)\.map\(e=>(\w+)\.find', s).group(1)
    chl = one(r'!(\w+)\.some\(function\(x\)\{return"c"\+x\.id===key\}\)', s).group(1)
    tbl = one(r'let n=(?:__mxM\[e\]\|\|)?(\w+)\[e\];if\(!n&&e===`upload\.getFile`\)', s).group(1)
    hc = one(r'(\w+)=new Set\(\[`u1`\]\)', s).group(1)
    # 1) снять старый ext3
    if B in s:
        a = s.index(B); b = s.index(E) + len(E)
        s = s[:a] + s[b:].lstrip('\n')
    # 2) вставить после ext2
    ext = EXT
    for k, v in {'__TC__': tc, '__UC__': uc, '__PIN__': hc, '__PEER__': ad, '__NC__': nc, '__Q__': Q, '__USERS__': us, '__CHATS__': chl, '__TBL__': tbl}.items():
        ext = ext.replace(k, v)
    anchor = '/* ==== конец ext2 ==== */'
    if anchor not in s: sys.exit('ext2 not applied in ' + os.path.basename(p) + ' (run patch_ext2.py first)')
    i = s.index(anchor) + len(anchor)
    s = s[:i] + '\n' + ext + s[i:]
    # 3) диспетчер: наши методы приоритетнее таблицы-заглушки
    new = 'let n=__mxM[e]||'
    rx = re.compile(r'let n=(?:__mxM\[e\]\|\|)?(\w+)\[e\];if\(!n&&e===`upload\.getFile`\)n=__mxGetFile;')
    mm = rx.search(s)
    if not mm: sys.exit('dispatcher anchor missing in ' + os.path.basename(p))
    s = s[:mm.start()] + 'let n=__mxM[e]||' + mm.group(1) + '[e];if(!n&&e===`upload.getFile`)n=__mxGetFile;' + s[mm.end():]
    # 4) каналы/inputPeerChannel -> тот же ключ c<id>, как у чатов
    old = '`inputPeerChat`?`c`+e.chat_id:`u100`'
    if old in s and 'inputPeerChannel' not in s[s.index(old) - 120:s.index(old) + 200]:
        s = s.replace(old, '`inputPeerChat`?`c`+e.chat_id:e._===`inputPeerChannel`?`c`+e.channel_id:`u100`', 1)
    open(p, 'w', encoding='utf8').write(s)
    print('patched', os.path.basename(p), dict(tc=tc, uc=uc, pin=hc, peer=ad, nc=nc, Q=Q))

# штамп версии для сброса кэша в static/tg/index.html: меняется при каждом изменении ext3.js
import hashlib
stamp = hashlib.sha1(EXT.encode('utf8')).hexdigest()[:10]
ip = os.path.join(ROOT, 'static', 'tg', 'index.html')
if os.path.exists(ip):
    h = open(ip, encoding='utf8').read()
    h2 = re.sub(r'(<script id="mx-cache-reset">.*?var V = ")[^"]*(")', lambda m: m.group(1) + stamp + m.group(2), h, count=1, flags=re.S)
    if h2 != h:
        open(ip, 'w', encoding='utf8').write(h2)
    print('cache stamp', stamp)
