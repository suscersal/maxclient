/* ==== MAX adapter: вместо фейковых данных Web K берёт чаты/сообщения из bridge.py (/relay) ==== */
var __mx={ws:null,ready:null,self:null,chats:{},keyChat:{},chatKey:{},contacts:{},seen:{},loaded:{},done:{},maxIdOf:{},tgIdOf:{},hi:1000000,lo:999999,lim:{},q:Promise.resolve(),pend:new Map(),waitAck:null,sentOut:{}};
function __mxLog(){try{console.log.apply(console,["[max]"].concat([].slice.call(arguments)))}catch(e){}}
function __mxName(c){
  if(!c)return null;var ns=c.names;if(!Array.isArray(ns)||!ns.length)return null;
  var lab=function(n){return n&&((n.name&&String(n.name).trim())||((n.firstName||"")+" "+(n.lastName||"")).trim())};
  for(var i=0;i<ns.length;i++){var l=lab(ns[i]);if(l)return l}return null}
function __mxTgUser(id){return String(id)===String(__mx.self)?__TC__:Number(id)}
function __mxUser(id){
  var tg=__mxTgUser(id),u=__CC__.find(function(x){return x.id===tg});
  var c=__mx.contacts[id],nm=__mxName(c)||(tg===__TC__?"Вы":"Контакт #"+id),p=nm.split(" "),f=p.shift()||nm,l=p.join(" ");
  if(!u){u={_:"user",pFlags:{contact:tg!==__TC__,mutual_contact:tg!==__TC__,self:tg===__TC__},id:tg,access_hash:"1",first_name:f,last_name:l,phone:(c&&c.phone)?String(c.phone):"",status:{_:"userStatusRecently",pFlags:{}}};__CC__.push(u)}
  else{u.first_name=f;u.last_name=l}
  return u}
function __mxOther(chat){
  var ids=Object.keys(chat.participants||{}),o=ids.filter(function(i){return String(i)!==String(__mx.self)});
  return o.length?o[0]:null}
function __mxKey(chat){
  if(chat.type==="DIALOG"){var o=__mxOther(chat);return"u"+(o==null?__TC__:__mxTgUser(o))}
  return"c"+Math.abs(Number(chat.id))}
function __mxConnect(){
  if(__mx.ready)return __mx.ready;
  __mx.ready=new Promise(function(res,rej){
    var ws=new WebSocket("ws://"+location.host+"/relay");__mx.ws=ws;
    ws.onerror=function(){rej(new Error("relay"))};
    ws.onclose=function(){__mx.ready=null;__mx.ws=null;__mx.pend.forEach(function(p){p.rej(new Error("closed"))});__mx.pend.clear()};
    ws.onmessage=function(ev){
      var d;try{d=JSON.parse(ev.data)}catch(e){return}
      if(d._seqAck){if(__mx.waitAck&&__mx.waitAck.op===d.opcode){__mx.waitAck.seq=d.seq;__mx.waitAck.go(d.seq)}return}
      if(d.type==="session_restored"){res();return}
      if(d.type==="auth_required"||d._auth_error){rej(new Error("auth"));return}
      if(d.error&&d.offline&&!d.opcode){rej(new Error(d.details||"offline"));return}
      if(d.seq!=null&&(d.cmd===256||d.cmd===768)){var p=__mx.pend.get(d.seq);if(p){__mx.pend.delete(d.seq);d.cmd===256?p.res(d.payload):p.rej(d.payload||new Error("err"));return}}
      if(d.opcode===128&&d.payload)__mxPush(d.payload)};
    setTimeout(function(){rej(new Error("timeout"))},20000)});
  __mx.ready.catch(function(){__mx.ready=null});
  return __mx.ready}
function __mxCall(op,payload){
  var run=function(){return __mxConnect().then(function(){return new Promise(function(res,rej){
    var w={op:op,seq:null,go:function(seq){__mx.pend.set(seq,{res:res,rej:rej});setTimeout(function(){if(__mx.pend.delete(seq))rej(new Error("timeout"))},20000)}};
    __mx.waitAck=w;__mx.ws.send(JSON.stringify({opcode:op,payload:payload}));
    setTimeout(function(){if(w.seq==null)rej(new Error("no ack"))},8000)})})};
  var r=__mx.q.then(run,run);__mx.q=r.catch(function(){});return r}
function __mxAddMsgs(key,msgs){
  var list=msgs.slice().sort(function(a,b){return(a.time||0)-(b.time||0)}),made=[];
  var seen=__mx.seen[key]||(__mx.seen[key]={}),lim=__mx.lim[key];
  var fresh=[];
  list.forEach(function(m){
    var id=String(m.id);if(seen[id]||m.deleted)return;
    var out=String(m.sender)===String(__mx.self),text=m.text||"";
    if(!text&&m.attaches&&m.attaches.length)text="📎 "+String(m.attaches[0]._type||"Вложение");
    var from=out?__TC__:(key[0]==="u"?+key.slice(1):__mxTgUser(m.sender));
    if(!out&&key[0]==="c")__mxUser(m.sender);
    var o=__Q__(key,out,text,0,from,{date:Math.floor((m.time||Date.now())/1e3)});
    __FC__[key].pop();seen[id]=1;o.__mx=id;o.__t=m.time||Date.now();fresh.push(o)});
  if(!fresh.length)return made;
  var older=lim?fresh.filter(function(o){return o.__t<lim.min}):[],rest=lim?fresh.filter(function(o){return o.__t>=lim.min}):fresh;
  for(var i=older.length-1;i>=0;i--)older[i].id=__mx.lo--;
  rest.forEach(function(o){o.id=__mx.hi++});
  fresh.forEach(function(o){__mx.tgIdOf[o.__mx]=o.id;__mx.maxIdOf[o.id]=o.__mx;
    var l=__mx.lim[key]||(__mx.lim[key]={min:o.__t,max:o.__t});if(o.__t<l.min)l.min=o.__t;if(o.__t>l.max)l.max=o.__t;delete o.__mx;delete o.__t});
  __FC__[key]=(__FC__[key]||[]).concat(fresh).sort(function(a,b){return a.id-b.id});
  return fresh}
function __mxSync(){
  if(__mx.syncP)return __mx.syncP;
  __mx.syncP=__mxCall(19,{chatsSync:0,contactsSync:0,interactive:true}).then(function(p){
    var prof=p.profile&&p.profile.contact;if(prof){__mx.self=prof.id;__mx.contacts[prof.id]=prof}
    (p.contacts||[]).forEach(function(c){__mx.contacts[c.id]=c});
    __CC__.length=0;__LC__.length=0;__GC__.length=0;__HC__.clear();
    Object.keys(__FC__).forEach(function(k){delete __FC__[k]});Object.keys(__PC__).forEach(function(k){delete __PC__[k]});Object.keys(__MC__).forEach(function(k){delete __MC__[k]});
    __mxUser(__mx.self);
    (p.chats||[]).forEach(function(chat){
      var key=__mxKey(chat);if(__mx.keyChat[key]!=null&&__GC__.indexOf(key)>=0)return;
      __mx.keyChat[key]=chat.id;__mx.chatKey[chat.id]=key;
      if(chat.type==="DIALOG"){var o=__mxOther(chat);if(o!=null)__mxUser(o)}
      else if(!__LC__.some(function(x){return"c"+x.id===key})){__LC__.push({_:"chat",pFlags:{},id:Math.abs(Number(chat.id)),title:chat.title||"Без названия",photo:{_:"chatPhotoEmpty"},participants_count:chat.participantsCount||Object.keys(chat.participants||{}).length||2,date:Math.floor((chat.created||chat.lastEventTime||Date.now())/1e3),version:1})}
      if(chat.lastMessage){__mxAddMsgs(key,[chat.lastMessage]);if(__FC__[key]&&__FC__[key].length){__GC__.push(key);if(chat.newMessages){__MC__[key]=chat.newMessages;__PC__[key]=0}}}});
    __mx.synced=1;
    var miss=[];(p.chats||[]).forEach(function(c){if(c.type==="DIALOG"){var o=__mxOther(c);if(o!=null&&!__mx.contacts[o])miss.push(Number(o))}});
    if(miss.length)__mxCall(32,{contactIds:miss}).then(function(r){(r.contacts||[]).forEach(function(c){__mx.contacts[c.id]=c;__mxUser(c.id)})}).catch(function(){});
  }).catch(function(e){__mx.syncP=null;__mxLog("sync failed",e);throw{code:500,type:"MAX_OFFLINE",handled:!0}});
  return __mx.syncP}
function __mxLoad(key,offsetId){
  var cid=__mx.keyChat[key];if(cid==null)return Promise.resolve();
  if(!__mx.loaded[key]){
    return __mxCall(49,{chatId:cid,from:Date.now()+864e5,forward:0,backward:50,getMessages:true}).then(function(p){
      __mx.loaded[key]=1;__mxAddMsgs(key,p.messages||[])}).catch(function(e){__mxLog("history failed",e)})}
  var arr=__FC__[key]||[];
  if(offsetId&&arr.length&&arr[0].id>=offsetId&&__mx.lim[key]&&!__mx.done[key]){
    return __mxCall(49,{chatId:cid,from:__mx.lim[key].min-1,forward:0,backward:50,getMessages:true}).then(function(p){
      if(!__mxAddMsgs(key,p.messages||[]).length)__mx.done[key]=1}).catch(function(){})}
  return Promise.resolve()}
function __mxPush(pl){
  var m=pl.message||pl,cid=pl.chatId!=null?pl.chatId:m.chatId,key=__mx.chatKey[cid];
  if(!key||!__FC__[key])return;
  var out=String(m.sender)===String(__mx.self);
  if(out&&__mx.sentOut[key]&&__mx.sentOut[key].length){var i=__mx.sentOut[key].findIndex(function(s){return s.text===(m.text||"")});if(i>=0){var s=__mx.sentOut[key].splice(i,1)[0];__mx.seen[key][String(m.id)]=1;s.o.__mxid=String(m.id);__mx.tgIdOf[String(m.id)]=s.o.id;__mx.maxIdOf[s.o.id]=String(m.id);return}}
  var made=__mxAddMsgs(key,[m]);if(!made.length)return;
  if(!out){__MC__[key]=(__MC__[key]||0)+1}
  __XC__({_:"updateNewMessage",message:made[0],pts:++__NC__,pts_count:1})}
function __mxSend(key,e,o){
  var cid=__mx.keyChat[key];if(cid==null)return;
  (__mx.sentOut[key]||(__mx.sentOut[key]=[])).push({text:e.message,o:o});
  __mxCall(64,{chatId:cid,message:{text:e.message,cid:Date.now()},notify:true}).then(function(p){
    var mm=p&&(p.message||p),id=mm&&mm.id;if(id!=null){__mx.seen[key][String(id)]=1;o.__mxid=String(id);__mx.tgIdOf[String(id)]=o.id;__mx.maxIdOf[o.id]=String(id);var l=__mx.sentOut[key],i=l?l.findIndex(function(s){return s.o===o}):-1;if(i>=0)l.splice(i,1)}
  }).catch(function(err){__mxLog("send failed",err)})}
function __mxRead(key,maxTgId){
  var cid=__mx.keyChat[key],mid=__mx.maxIdOf[maxTgId];if(cid==null||mid==null)return;
  __mxCall(50,{type:"READ_MESSAGE",chatId:cid,messageId:mid,mark:Date.now()}).catch(function(){})}
/* ==== конец адаптера ==== */
