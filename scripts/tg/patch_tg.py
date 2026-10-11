# Вшивает adapter.js в воркеры сборки Web K: python3 scripts/tg/patch_tg.py <папка-сборки>
import re, sys, shutil, os
HERE=os.path.dirname(os.path.abspath(__file__))
SRC=sys.argv[1] if len(sys.argv)>1 else os.path.join(HERE,'tweb-build')  # исходная сборка Web K (с заглушкой)
DST=os.path.join(HERE,'..','..','static','tg')
AD=open(os.path.join(HERE,'adapter.js'),encoding='utf8').read()
if os.path.exists(DST): shutil.rmtree(DST)
shutil.copytree(SRC,DST)
def one(rx,s,flags=0):
    m=re.search(rx,s,flags)
    if not m: raise SystemExit('anchor not found: '+rx)
    return m
for fn in sorted(os.listdir(DST)):
    if not (fn.startswith('index.worker-') and fn.endswith('.js')): continue
    p=os.path.join(DST,fn); s=open(p,encoding='utf8').read()
    ic=one(r'function \w+\(e\)\{(\w+)=e\}(?:var|const|let) \w+=\{_:`peerNotifySettings`',s).group(1)
    m=re.search(r'(\w+)=100,',s[:s.find('peerNotifySettings`')]); tc=m.group(1) if m else '100'
    nc=one(r'(?:,|let |var )(\w+)=1,(\w+)=1,'+ic+r';function',s).group(1)
    cc=one(r'(\w+)=\[\w+\(\w+,`Вы`',s).group(1)
    lc=one(r'(\w+)=\[\{_:`chat`,pFlags:\{\},id:5001',s).group(1)
    fc,pc,mc,Q=one(r'(\w+)=\{\},(\w+)=\{\},(\w+)=\{\};function (\w+)\(e,t,n,r,i,a=\{\}\)',s).groups()
    hc,gc=one(r'(\w+)=new Set\(\[`u1`\]\),(\w+)=\[`u1`,`c5001`',s).groups()
    sc_,xc=None,one(r'function (\w+)\(e\)\{'+ic+r'&&'+ic+r'\(\{_:`updateShort`',s).group(1)
    Sc=one(r'function (\w+)\(e\)\{if\(e===`u100`\)return;',s).group(1)
    uc=one(r'(\w+)=e=>e\._===`inputPeerUser`\?`u`\+e\.user_id',s).group(1)
    tbl=one(r'(?:var|const|let) (\w+)=\{"help\.getConfig"',s).group(1)
    ad=AD
    for k,v in {'__TC__':tc,'__CC__':cc,'__LC__':lc,'__FC__':fc,'__PC__':pc,'__MC__':mc,'__HC__':hc,'__GC__':gc,'__Q__':Q,'__XC__':xc,'__NC__':nc}.items(): ad=ad.replace(k,v)
    # 1) вставляем адаптер перед таблицей методов
    i=s.find(re.search(r'(?:var|const|let) '+tbl+r'=\{"help\.getConfig"',s).group(0)); s=s[:i]+ad+s[i:]
    # 2) автоответ заглушки отключаем
    s=s.replace('function '+Sc+'(e){if(e===`u100`)return;','function '+Sc+'(e){return;',1)
    # 3) методы
    def rep(a,b):
        global s
        assert s.count(a)==1,(fn,a,s.count(a)); s=s.replace(a,b)
    rep('"messages.getDialogs":()=>{let e=','"messages.getDialogs":async()=>{await __mxSync();let e=')
    rep('"messages.getPinnedDialogs":()=>(','"messages.getPinnedDialogs":async()=>(await __mxSync(),')
    rep('"messages.getPeerDialogs":e=>(','"messages.getPeerDialogs":async e=>(await __mxSync(),')
    rep('"messages.getHistory":e=>{let t=','"messages.getHistory":async e=>{await __mxSync();await __mxLoad('+uc+'(e.peer),e.offset_id);let t=')
    rep('"messages.readHistory":e=>{let t='+uc+'(e.peer);','"messages.readHistory":e=>{let t='+uc+'(e.peer);__mxRead(t,e.max_id);')
    rep('"users.getUsers":e=>(','"users.getUsers":async e=>(await __mxSync(),')
    rep('"contacts.getContacts":()=>(','"contacts.getContacts":async()=>(await __mxSync(),')
    m=one(r'return '+Sc+r'\(t\),\{_:`updates`',s); s=s.replace(m.group(0),'return __mxSend(t,e,n),{_:`updates`',1)
    open(p,'w',encoding='utf8').write(s)
    print(fn,'ok',dict(tc=tc,ic=ic,cc=cc,lc=lc,fc=fc,Q=Q,xc=xc,Sc=Sc,uc=uc,tbl=tbl))
