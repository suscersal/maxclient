#!/usr/bin/env python3
"""Идемпотентно дополняет воркеры static/tg/index.worker-*.js расширением ext2.js
(поиск, пресенс, каналы без отправителя, фикс аватарок). Запуск из корня репо:
    python3 scripts/tg/patch_ext2.py
"""
import re, os, sys, glob
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EXT = open(os.path.join(HERE, 'ext2.js'), encoding='utf8').read()
B, E = '/* ==== MAX adapter ext2', '/* ==== конец ext2 ==== */'

def one(rx, s):
    m = re.search(rx, s)
    if not m: sys.exit('anchor not found: ' + rx)
    return m

for p in sorted(glob.glob(os.path.join(ROOT, 'static', 'tg', 'index.worker-*.js'))):
    s = open(p, encoding='utf8').read()
    ic = one(r'function \w+\(e\)\{(\w+)=e\}(?:var|const|let) \w+=\{_:`peerNotifySettings`', s).group(1)
    m = re.search(r'(\w+)=100,', s[:s.find('peerNotifySettings`')]); tc = m.group(1) if m else '100'
    cc = one(r'(\w+)=\[\w+\(\w+,`Вы`', s).group(1)
    lc = one(r'(\w+)=\[\{_:`chat`,pFlags:\{\},id:5001', s).group(1)
    fc, pc, mc, Q = one(r'(\w+)=\{\},(\w+)=\{\},(\w+)=\{\};function (\w+)\(e,t,n,r,i,a=\{\}\)', s).groups()
    uc = one(r'(\w+)=e=>e\._===`inputPeerUser`\?`u`\+e\.user_id', s).group(1)
    # 1) снять старый ext2
    if B in s:
        a = s.index(B); b = s.index(E) + len(E)
        s = s[:a] + s[b:].lstrip('\n')
    # 2) вставить после расширения аккаунтов/аватарок (или после ядра адаптера)
    ext = EXT
    for k, v in {'__TC__': tc, '__CC__': cc, '__LC__': lc, '__FC__': fc, '__UC__': uc, '__IC__': ic}.items():
        ext = ext.replace(k, v)
    anchor = '/* ==== конец расширения ==== */'
    if anchor not in s: anchor = '/* ==== конец адаптера ==== */'
    i = s.index(anchor) + len(anchor)
    s = s[:i] + '\n' + ext + s[i:]

    def rep(old, new, must=True):
        global s
        if new in s: return
        if old not in s:
            if must: sys.exit('patch anchor missing in %s: %s' % (os.path.basename(p), old[:80]))
            return
        s = s.replace(old, new, 1)
    # аватарки: идентичность картинки у MAX — в ?r=..., нельзя резать query
    rep('var k=String(url).split("?")[0],h1=5381', 'var k=String(url),h1=5381', must=False)
    # тип чата и пресенс
    rep('__mx.keyChat[key]=chat.id;__mx.chatKey[chat.id]=key;', '__mx.keyChat[key]=chat.id;__mx.chatKey[chat.id]=key;__mx.chType[key]=chat.type;')
    rep('    __mx.synced=1;',
        '    var pr=p.presence||{};Object.keys(pr).forEach(function(id){var u=%s.find(function(x){return x.id===__mxTgUser(id)});if(!u||u.id===%s)return;var v=pr[id]||{},sn=v.seen||0;if(sn>1e12)sn=Math.floor(sn/1e3);u.status=v.status===1?{_:"userStatusOnline",expires:Math.floor(Date.now()/1e3)+3600}:(sn?{_:"userStatusOffline",was_online:sn}:u.status)});\n    __mx.synced=1;' % (cc, tc))
    # отправитель: каналы/служебные без from_id, неизвестных подтягиваем
    old = ('    var from=out?%s:(key[0]==="u"?+key.slice(1):__mxTgUser(m.sender));\n    if(!out&&key[0]==="c")__mxUser(m.sender);\n'
           '    var o=%s(key,out,text,0,from,{date:Math.floor((m.time||Date.now())/1e3)});\n    %s[key].pop();seen[id]=1;') % (tc, Q, fc)
    new = ('    var sid=m.sender,noFrom=!out&&key[0]==="c"&&(!(Number(sid)>0)||__mx.chType[key]==="CHANNEL");\n'
           '    var from=out?%s:(key[0]==="u"?+key.slice(1):(noFrom?%s:__mxTgUser(sid)));\n'
           '    if(!out&&key[0]==="c"&&!noFrom){__mxUser(sid);__mxFetchUsers([sid])}\n'
           '    var o=%s(key,out,text,0,from,{date:Math.floor((m.time||Date.now())/1e3)});\n'
           '    if(noFrom){delete o.from_id;o.pFlags=o.pFlags||{};o.pFlags.post=!0}\n    %s[key].pop();seen[id]=1;') % (tc, tc, Q, fc)
    rep(old, new)
    # методы
    rep('"messages.search":()=>({_:`messages.messages`,messages:[],chats:[],users:[]})',
        '"messages.search":e=>__mxSearchMsgs(e),"messages.searchGlobal":e=>__mxSearchMsgs(e),"contacts.search":e=>__mxFound(e),'
        '"contacts.getSponsoredPeers":()=>({_:`contacts.sponsoredPeersEmpty`}),"contacts.resolvePhone":e=>__mxResolvePhone(e),"contacts.resolveUsername":e=>__mxResolveName(e)')
    open(p, 'w', encoding='utf8').write(s)
    print('patched', os.path.basename(p))
