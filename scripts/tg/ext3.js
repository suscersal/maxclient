/* ==== MAX adapter ext3: вложения (фото/файлы/видео/голосовые/стикеры), закрепление, отправка медиа ==== */
/* Лог воркера -> debug-консоль страницы (BroadcastChannel "mxlog") */
try{if(!self.__mxBC){self.__mxBC=new BroadcastChannel("mxlog");
  var __mxTx=function(x){try{return typeof x==="string"?x:(x&&x.stack)||JSON.stringify(x)}catch(e){return String(x)}};
  ["log","warn","error"].forEach(function(l){var o=console[l];console[l]=function(){
    try{var t=[].slice.call(arguments).map(__mxTx).join(" ");if(l!=="log"||t.indexOf("[max")===0||t.indexOf("[mock")===0)self.__mxBC.postMessage({l:l,a:t.slice(0,600)})}catch(e){}
    return o.apply(console,arguments)}});
  self.addEventListener("unhandledrejection",function(ev){try{self.__mxBC.postMessage({l:"error",a:"unhandled: "+__mxTx(ev.reason)})}catch(e){}});
  self.addEventListener("error",function(ev){try{self.__mxBC.postMessage({l:"error",a:"worker error: "+(ev.message||"")})}catch(e){}})}}catch(e){}
__mx.media={};__mx.trans={};__mx.favs=null;__mx.folder=null;__mx.upl={};__mx.pinMsg={};
function __mxH(s){var h1=5381,h2=52711,i;for(i=0;i<s.length;i++){var c=s.charCodeAt(i);h1=((h1<<5)+h1+c)>>>0;h2=((h2<<5)^(h2>>>2)^c)>>>0}return String(h1*1048576+(h2&1048575)+1)}
function __mxMime(name,def){
  var e=String(name||"").split("?")[0].split(".").pop().toLowerCase(),m={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",mp4:"video/mp4",mov:"video/quicktime",webm:"video/webm",mkv:"video/x-matroska",mp3:"audio/mpeg",ogg:"audio/ogg",opus:"audio/ogg",m4a:"audio/mp4",aac:"audio/aac",wav:"audio/wav",pdf:"application/pdf",zip:"application/zip",txt:"text/plain",json:"application/json",doc:"application/msword",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",xls:"application/vnd.ms-excel",xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"};
  return m[e]||def||"application/octet-stream"}
function __mxDocMedia(id,date,mime,size,attrs,thumbs){
  var d={_:"document",pFlags:{},id:id,access_hash:"1",file_reference:[],date:date,mime_type:mime,size:size||0,dc_id:2,attributes:attrs};
  if(thumbs)d.thumbs=thumbs;
  return{_:"messageMediaDocument",pFlags:{},document:d}}
/* Превращаем attaches сообщения MAX в media сообщения Web K. Регистрируем источник для upload.getFile. */
function __mxMedia(key,o,m){
  var cid=__mx.keyChat[key],at=m.attaches||[],pick=null,idx=-1,i,extra=0;
  for(i=0;i<at.length;i++){var t=at[i]&&at[i]._type;
    if(t==="PHOTO"||t==="FILE"||t==="VIDEO"||t==="AUDIO"||t==="STICKER"){if(!pick){pick=at[i];idx=i}else if(t==="PHOTO"&&pick._type==="PHOTO")extra++}}
  if(!pick)return;
  var type=pick._type,id=(type==="STICKER"&&pick.stickerId!=null)?String(pick.stickerId):__mxH(cid+":"+m.id+":"+idx),date=o.date,rec={kind:type,chatId:cid,msgId:String(m._o?m._o.id:m.id),msgTime:m.time||0,idx:m._o?m._o.idx:idx,attach:pick,url:null,size:0},media;
  __mx.media[id]=rec;
  if(type==="PHOTO"){
    rec.url=pick.baseUrl||pick.url||null;
    media={_:"messageMediaPhoto",pFlags:{},photo:{_:"photo",pFlags:{},id:id,access_hash:"1",file_reference:[],date:date,sizes:[{_:"photoSize",type:"x",w:pick.width||1024,h:pick.height||768,size:0}],dc_id:2}}}
  else if(type==="FILE"){
    var nm=pick.name||"file";rec.size=pick.size||0;
    media=__mxDocMedia(id,date,__mxMime(nm),rec.size,[{_:"documentAttributeFilename",file_name:nm}])}
  else if(type==="VIDEO"){
    var w=pick.width||640,h=pick.height||360,th=pick.thumbnail?[{_:"photoSize",type:"m",w:w,h:h,size:0}]:null;
    media=__mxDocMedia(id,date,"video/mp4",0,[{_:"documentAttributeVideo",pFlags:pick.videoType===1?{round_message:!0}:{},duration:Math.round((pick.duration||0)/1e3),w:w,h:h},{_:"documentAttributeFilename",file_name:"video.mp4"}],th)}
  else if(type==="AUDIO"){
    rec.url=pick.baseUrl||pick.fileUrl||pick.url||null;
    media=__mxDocMedia(id,date,"audio/ogg",0,[{_:"documentAttributeAudio",pFlags:{voice:!0},duration:Math.round((pick.duration||0)/1e3)},{_:"documentAttributeFilename",file_name:"voice.ogg"}])}
  else{/* STICKER */
    rec.url=pick.url||null;if(pick.stickerId!=null)rec.stickerId=pick.stickerId;var sw=pick.width||512,sh=pick.height||512,lot=pick.lottieUrl&&(!pick.stickerType||pick.stickerType==="LOTTIE")?pick.lottieUrl:null;
    if(lot)rec.lottie=lot;
    media=__mxDocMedia(id,date,lot?"application/x-tgsticker":"image/webp",0,[{_:"documentAttributeImageSize",w:sw,h:sh},{_:"documentAttributeSticker",pFlags:{},alt:(pick.tags&&pick.tags[0])||"🙂",stickerset:{_:"inputStickerSetEmpty"}},{_:"documentAttributeFilename",file_name:lot?"sticker.tgs":"sticker.webp"}])}
  var tmid=type==="AUDIO"?(pick.audioId!=null?pick.audioId:pick.mediaId):(type==="VIDEO"?pick.videoId:null);
  if(tmid!=null&&tmid!==undefined)__mx.trans[o.id]={chatId:cid,msgId:String(m.id),mediaId:tmid};
  o.media=media;
  if(!m.text||/^📎 /.test(o.message))o.message=m.text||"";
  if(extra)o.message=(o.message?o.message+"\n":"")+"(+"+extra+" фото)"}
/* Пересылки и ответы (payload.link): FORWARD -> fwd_from.from_name, REPLY -> reply_to */
function __mxLinks(key,o,m){
  var L=m&&m.link;if(!L||typeof L!=="object")return;
  var t=String(L.type||"").toUpperCase(),fm=L.message||{};
  if(t==="FORWARD"){
    var name=null;
    if(String(fm.type||"").toUpperCase()==="CHANNEL"&&L.chatName)name=L.chatName;
    else if(fm.sender!=null){name=String(fm.sender)===String(__mx.self)?"Вы":__mxName(__mx.contacts[fm.sender])}
    o.fwd_from={_:"messageFwdHeader",pFlags:{},from_name:name||L.chatName||"Неизвестно",date:Math.floor((fm.time||m.time||Date.now())/1e3)}}
  else if(t==="REPLY"){
    var rid=L.messageId!=null?L.messageId:fm.id,tg=rid!=null?__mx.tgIdOf[String(rid)]:null;
    if(tg!=null)o.reply_to={_:"messageReplyHeader",pFlags:{},reply_to_msg_id:tg}}}
var __mxAddMsgs0=__mxAddMsgs;
__mxAddMsgs=function(key,msgs){
  var ex=[],byId={};
  (msgs||[]).forEach(function(m){
    if(!m||m.id==null){return}
    var at=m.attaches||[],mi=[];
    at.forEach(function(a,i){if(a&&(a._type==="PHOTO"||a._type==="VIDEO"))mi.push(i)});
    if(mi.length<2){ex.push(m);return}
    var gid=__mxH("alb:"+key+":"+m.id),base=Object.assign({},m);
    base.attaches=at.filter(function(a,i){return mi.indexOf(i)<0||i===mi[0]});
    base._o={id:m.id,idx:mi[0]};base._g=gid;ex.push(base);
    mi.slice(1).forEach(function(ai,n){ex.push({id:m.id+"#"+(n+1),time:(m.time||0)+n+1,sender:m.sender,text:"",attaches:[at[ai]],_o:{id:m.id,idx:ai},_g:gid,_syn:1})})});
  ex.forEach(function(m){byId[String(m.id)]=m});
  var fresh=__mxAddMsgs0(key,ex);
  fresh.forEach(function(o){try{
    var mid=__mx.maxIdOf[o.id],m=mid!=null&&byId[mid];
    if(m){__mxMedia(key,o,m);__mxLinks(key,o,m);if(m._g)o.grouped_id=m._g;if(m._syn)__mx.maxIdOf[o.id]=String(m._o.id)}
  }catch(e){__mxLog("media failed",e)}});
  return fresh};
/* Свежая ссылка на вложение: сообщение перечитываем (ссылки MAX протухают). */
async function __mxRefresh(rec){
  if(!rec.msgTime)return null;
  var p=await __mxCall(49,{chatId:rec.chatId,from:rec.msgTime+1,forward:0,backward:1,getMessages:true});
  var f=((p&&p.messages)||[]).find(function(x){return x&&String(x.id)===rec.msgId}),a=f&&(f.attaches||[])[rec.idx];
  return a?(a.baseUrl||a.fileUrl||a.url||null):null}
async function __mxMediaUrl(rec,fresh){
  if(rec.kind==="FILE"){
    if(!fresh&&rec.url)return rec.url;
    var r=await fetch("/api/file-url"+__mxAccQ,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fileId:rec.attach.fileId,chatId:rec.chatId,messageId:rec.msgId})});
    var j=await r.json().catch(function(){return{}});return rec.url=j.url||null}
  if(rec.kind==="VIDEO"){
    if(!fresh&&rec.url)return rec.url;
    var a=rec.attach,r2=await fetch("/api/video-sources"+__mxAccQ,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messageId:rec.msgId,chatId:rec.chatId,token:a.token||a.videoToken||"",videoId:a.videoId||0})});
    var j2=await r2.json().catch(function(){return{}}),src=j2.sources||{},best=src["480p"]||src["720p"]||src["360p"]||src["1080p"]||src["240p"]||src["144p"]||null,ks=Object.keys(src);
    if(!best&&ks.length)best=src[ks[0]];
    if(best&&/\.m3u8(\?|$)/.test(best)){__mxLog("video: только HLS, скачать нельзя",ks.join(","));best=null}
    if(!best)__mxLog("video: нет источников",JSON.stringify(j2).slice(0,200));
    return rec.url=best}
  if(fresh){var u=await __mxRefresh(rec);if(u)rec.url=u}
  return rec.url}
async function __mxGzip(buf){var cs=new CompressionStream("gzip"),w=cs.writable.getWriter();w.write(buf);w.close();return new Uint8Array(await new Response(cs.readable).arrayBuffer())}
async function __mxGetMedia(a){
  var loc=a&&a.location,id=loc&&loc.id!=null?String(loc.id):null,rec=id&&__mx.media[id];
  if(!rec)return null;
  var off=a.offset||0,lim=a.limit||524288,thumb=!!(loc.thumb_size&&loc._==="inputDocumentFileLocation"&&rec.attach.thumbnail),
    ranged=!thumb&&rec.size>0&&(rec.kind==="FILE"),img=thumb||rec.kind==="PHOTO"||rec.kind==="STICKER",err=null;
  if(!ranged&&off>0)return{_:"upload.file",type:{_:"storage.fileUnknown"},mtime:0,bytes:new Uint8Array(0)};
  if(rec.lottie&&!thumb){
    try{var lr=await fetch("/lottie?url="+encodeURIComponent(rec.lottie));
      if(lr.ok)return{_:"upload.file",type:{_:"storage.fileUnknown"},mtime:0,bytes:await __mxGzip(new Uint8Array(await lr.arrayBuffer()))};
      err="lottie http "+lr.status}catch(e){err="lottie "+String(e&&e.message||e)}
    __mxLog("lottie failed",err);throw{code:400,type:"LOCATION_INVALID",handled:!0}}
  for(var n=0;n<2;n++){
    try{
      var url=thumb?rec.attach.thumbnail:await __mxMediaUrl(rec,n>0);
      if(!url){err="no url";continue}
      var ep=img?"/img":"/video",opt={};
      if(ep==="/video"&&ranged)opt.headers={Range:"bytes="+off+"-"+(off+lim-1)};
      var res=await fetch(ep+"?url="+encodeURIComponent(url),opt);
      if(!res.ok&&img&&res.status===400){res=await fetch("/video?url="+encodeURIComponent(url))}
      if(res.ok){var buf=new Uint8Array(await res.arrayBuffer());if(ranged&&res.status===200)buf=buf.subarray(off,off+lim);
        return{_:"upload.file",type:{_:"storage.fileUnknown"},mtime:0,bytes:buf}}
      err="http "+res.status;if(thumb)break
    }catch(e){err=String(e&&e.message||e)}}
  __mxLog("media http failed",rec.kind,err);throw{code:400,type:"LOCATION_INVALID",handled:!0}}
async function __mxGetFile3(a){var r=await __mxGetMedia(a);return r||__mxGetFile(a)}
/* Диагностика аватарок: первые запросы upload.getFile по photo_id пишем в консоль */
var __mxGetFile0=__mxGetFile,__mxAvN=0;
__mxGetFile=async function(a){
  var loc=a&&a.location,pid=loc&&loc.photo_id!=null?String(loc.photo_id):null,url=pid&&__mx.photoUrl[pid],n=++__mxAvN;
  try{var r=await __mxGetFile0(a);if(n<=25)__mxLog("avatar",n,"pid",pid,"url",url?String(url).slice(0,70):"НЕТ URL","bytes",r&&r.bytes&&r.bytes.length,"off",a&&a.offset||0);return r}
  catch(e){__mxLog("avatar FAIL",n,pid,url?String(url).slice(0,70):"НЕТ URL",e&&e.type||e);throw e}};
/* ---- закрепление чатов (папка «Все чаты», favorites; opcodes 272/274) ---- */
function __mxIsAll(f){var t=(f.title||"").trim().toLowerCase();return f.id==="all.chat.folder"||t==="все"||t==="все чаты"||t==="all"||t==="all chats"}
function __mxApplyFavs(){
  var fav=(__mx.folder&&__mx.folder.favorites)||[];__PIN__.clear();
  fav.forEach(function(cid){var k=__mx.chatKey[cid];if(k)__PIN__.add(k)})}
async function __mxFolders(){
  try{var p=await __mxCall(272,{folderSync:0}),fs=(p&&p.folders)||[];
    __mx.folder=fs.find(__mxIsAll)||null;__mxApplyFavs()}catch(e){__mxLog("folders failed",e)}}
var __mxSync0=__mxSync;
__mxSync=function(){
  if(__mx.sync3)return __mx.sync3;
  __mx.sync3=__mxSync0().then(function(){return __mxFolders()}).catch(function(e){__mx.sync3=null;throw e});
  return __mx.sync3};
async function __mxToggleDialogPin(e){
  await __mxSync();
  var key=__UC__(e.peer&&e.peer.peer),cid=__mx.keyChat[key];
  if(cid==null)throw{code:400,type:"PEER_ID_INVALID",handled:!0};
  var f=__mx.folder;
  if(!f){await __mxFolders();f=__mx.folder}
  if(!f)throw{code:400,type:"FOLDER_NOT_FOUND",handled:!0};
  var fav=(f.favorites||[]).filter(function(x){return String(x)!==String(cid)});
  if(e.pinned)fav.unshift(cid);
  var pl={id:f.id,title:f.title,include:f.include||[],filters:f.filters||[],options:f.options||[],favorites:fav};
  var r=await __mxCall(274,pl).catch(function(er){throw{code:400,type:"PIN_FAILED",handled:!0,details:er}});
  var nf=r&&r.folder&&typeof r.folder==="object"?r.folder:null;
  f.favorites=nf&&Array.isArray(nf.favorites)?nf.favorites:fav;
  __mxApplyFavs();return!0}
/* ---- закрепление сообщений (opcode 55) ---- */
async function __mxUpdatePinned(e){
  await __mxSync();
  var key=__UC__(e.peer),cid=__mx.keyChat[key],mid=__mx.maxIdOf[e.id];
  if(cid==null||mid==null)throw{code:400,type:"MESSAGE_ID_INVALID",handled:!0};
  var unpin=!!e.unpin;
  await __mxCall(55,{chatId:cid,notifyPin:!e.silent&&!unpin,pinMessageId:unpin?0:Number(mid)}).catch(function(er){throw{code:400,type:"PIN_FAILED",handled:!0,details:er}});
  if(unpin)delete __mx.pinMsg[key];else __mx.pinMsg[key]=e.id;
  var peer=__PEER__(key);
  return{_:"updates",updates:[{_:"updatePinnedMessages",pFlags:unpin?{}:{pinned:!0},peer:peer,messages:[e.id],pts:++__NC__,pts_count:1}],users:[],chats:[],date:Math.floor(Date.now()/1e3),seq:0}}
/* ---- отправка вложений: saveFilePart копим в памяти, sendMedia заливает через /api/upload-* и шлёт opcode 64 ---- */
function __mxSavePart(e){
  var id=String(e.file_id),u=__mx.upl[id]||(__mx.upl[id]={parts:{},n:0});
  if(!u.parts[e.file_part])u.n++;u.parts[e.file_part]=e.bytes instanceof Uint8Array?e.bytes:new Uint8Array(e.bytes||[]);return!0}
function __mxJoin(f){
  var u=__mx.upl[String(f.id)];if(!u)return null;
  var keys=Object.keys(u.parts).map(Number).sort(function(a,b){return a-b}),len=0,i;
  keys.forEach(function(k){len+=u.parts[k].length});
  var out=new Uint8Array(len),o=0;keys.forEach(function(k){out.set(u.parts[k],o);o+=u.parts[k].length});
  delete __mx.upl[String(f.id)];return out}
async function __mxSendMedia(e){
  await __mxSync();
  var key=__UC__(e.peer),cid=__mx.keyChat[key],im=e.media||{};
  if(cid==null)throw{code:400,type:"PEER_ID_INVALID",handled:!0};
  if(im._==="inputMediaDocument")return __mxSendSticker(e,key,cid,im);
  var isPhoto=im._==="inputMediaUploadedPhoto",isDoc=im._==="inputMediaUploadedDocument";
  if(!isPhoto&&!isDoc)throw{code:400,type:"MEDIA_INVALID",handled:!0};
  var f=im.file,bytes=__mxJoin(f);
  if(!bytes)throw{code:400,type:"FILE_PARTS_INVALID",handled:!0};
  var name=f.name||(isPhoto?"photo.jpg":"file"),mime=isPhoto?"image/jpeg":(im.mime_type||"application/octet-stream");
  var cap=e.message||"",date=Math.floor(Date.now()/1e3),id=__mxH("out:"+Date.now()+":"+name),media;
  if(isPhoto){media={_:"messageMediaPhoto",pFlags:{},photo:{_:"photo",pFlags:{},id:id,access_hash:"1",file_reference:[],date:date,sizes:[{_:"photoSize",type:"x",w:1024,h:768,size:0}],dc_id:2}}}
  else{var attrs=(im.attributes||[]).slice();if(!attrs.some(function(x){return x._==="documentAttributeFilename"}))attrs.push({_:"documentAttributeFilename",file_name:name});
    media=__mxDocMedia(id,date,mime,bytes.length,attrs)}
  var o=__Q__(key,!0,cap,0,__TC__,{entities:e.entities,media:media});
  /* локальная копия, чтобы превью/скачивание своего вложения работали без сети */
  var blob=new Blob([bytes],{type:mime}),rec={kind:"LOCAL",chatId:cid,msgId:"",msgTime:0,idx:0,attach:{},url:null,size:0,blob:blob};
  __mx.media[id]=rec;
  (__mx.sentOut[key]||(__mx.sentOut[key]=[])).push({text:cap,o:o});
  (async function(){
    try{
      var fd=new FormData();fd.append("file",new File([blob],name,{type:mime}));
      var res=await fetch(isPhoto?"/api/upload-photo":"/api/upload-file",{method:"POST",body:fd}),j=await res.json().catch(function(){return{}});
      if(!res.ok||j.error)throw new Error(j.error||("HTTP "+res.status));
      var at=isPhoto?{_type:"PHOTO",photoToken:j.photoToken}:{_type:"FILE",token:j.token};
      var p=await __mxCall(64,{chatId:cid,message:{text:cap,cid:Date.now(),attaches:[at]},notify:!0}),mm=p&&(p.message||p),mid=mm&&mm.id;
      if(mid!=null){__mx.seen[key][String(mid)]=1;o.__mxid=String(mid);__mx.tgIdOf[String(mid)]=o.id;__mx.maxIdOf[o.id]=String(mid);rec.msgId=String(mid);rec.kind="LOCAL"}
      var l=__mx.sentOut[key],i=l?l.findIndex(function(s){return s.o===o}):-1;if(i>=0)l.splice(i,1)
    }catch(er){__mxLog("send media failed",er)}})();
  return{_:"updates",updates:[{_:"updateMessageID",id:o.id,random_id:e.random_id},{_:"updateNewMessage",message:o,pts:++__NC__,pts_count:1}],users:[],chats:[],date:date,seq:0}}
/* Локальные вложения (только что отправленные): отдаём из памяти. */
var __mxGetMedia0=__mxGetMedia;
__mxGetMedia=async function(a){
  var l0=a&&a.location;
  if(l0&&l0._==="inputStickerSetThumb"){
    var s0=__mx.st.sets[String(l0.stickerset&&l0.stickerset.id)],u0=s0&&s0.iconUrl;
    if(u0){var r0=await fetch("/img?url="+encodeURIComponent(u0));if(!r0.ok)r0=await fetch("/video?url="+encodeURIComponent(u0));
      if(r0.ok)return{_:"upload.file",type:{_:"storage.fileUnknown"},mtime:0,bytes:new Uint8Array(await r0.arrayBuffer())}}
    throw{code:400,type:"LOCATION_INVALID",handled:!0}}
  var loc=a&&a.location,id=loc&&loc.id!=null?String(loc.id):null,rec=id&&__mx.media[id];
  if(rec&&rec.kind==="LOCAL"&&rec.blob){
    var buf=new Uint8Array(await rec.blob.arrayBuffer()),off=a.offset||0;
    return{_:"upload.file",type:{_:"storage.fileUnknown"},mtime:0,bytes:buf.subarray(off,off+(a.limit||buf.length))}}
  return __mxGetMedia0(a)};
/* ---- Premium бесплатно: свой пользователь всегда premium, покупка скрыта ---- */
function __mxFreePremium(arr){try{(arr||[]).forEach(function(u){if(u&&u._==="user"&&u.pFlags&&u.pFlags.self)u.pFlags.premium=!0})}catch(e){}}
/* Каналы MAX помечаем pFlags.broadcast: Web K по нему пишет «подписчиков» вместо «участников» */
function __mxMarkChannels(arr){try{(arr||[]).forEach(function(c){if(c&&c._==="chat"&&__mx.chType["c"+c.id]==="CHANNEL"){c.pFlags=c.pFlags||{};c.pFlags.broadcast=!0}})}catch(e){}}
var __mxDec0=__mxDecorate;
__mxDecorate=function(r){r=__mxDec0(r);if(r&&typeof r==="object"){__mxFreePremium(r.users);if(r.user)__mxFreePremium([r.user]);__mxMarkChannels(r.chats)}return r};
var __mxSyncP0=__mxSync;
__mxSync=function(){return __mxSyncP0().then(function(x){__mxFreePremium(__USERS__);__mxMarkChannels(__CHATS__);return x})};
function __mxJB(k,v){return{_:"jsonObjectValue",key:k,value:{_:"jsonBool",value:v}}}
function __mxAppConfig(){return{_:"help.appConfig",hash:0,config:{_:"jsonObject",value:[__mxJB("premium_purchase_blocked",!0),__mxJB("premium_playmarket_direct_currency_list",!1)]}}}
/* ---- расшифровка голосовых/кружков: opcode 202 через /api/transcribe/max-native (как в index.html) ---- */
async function __mxTranscribe(e){
  var mid=e&&e.msg_id,t=__mx.trans[mid],maxId=__mx.maxIdOf[mid];
  if(!t)throw{code:400,type:"MSG_VOICE_MISSING",handled:!0};
  var last="";
  for(var n=0;n<5;n++){
    try{
      var r=await fetch("/api/transcribe/max-native",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:Number(t.chatId),messageId:String(maxId!=null?maxId:t.msgId),mediaId:t.mediaId})});
      var j=await r.json().catch(function(){return{}});
      if(!r.ok||j.error)throw new Error(j.error||("HTTP "+r.status));
      return{_:"messages.transcribedAudio",pFlags:{},transcription_id:String(mid),text:String(j.text||"")}
    }catch(er){last=String(er&&er.message||er);
      if(!/status=0/.test(last))break;
      await new Promise(function(ok){setTimeout(ok,2000)})}}
  __mxLog("transcribe failed",last);throw{code:400,type:"TRANSCRIPTION_FAILED",handled:!0}}
/* ---- реальное число участников/подписчиков (CHAT_INFO, opcode 48) вместо «3» ---- */
__mx.pcount={};
function __mxSetCount(key,n){
  __mx.pcount[key]=n;var ch=null;
  __CHATS__.forEach(function(c){if("c"+c.id===key)ch=c});
  if(ch&&ch.participants_count!==n){ch.participants_count=n;return ch}
  return null}
async function __mxCountFor(raw,key){
  if(__mx.pcount[key]!=null)return __mx.pcount[key];
  try{var p=await __mxCall(48,{chatIds:[raw]});
    (p&&p.chats||[]).forEach(function(c){if(c&&typeof c.participantsCount==="number"&&String(c.id)===String(raw))__mx.pcount[key]=c.participantsCount})}catch(e){}
  return __mx.pcount[key]}
async function __mxCountsAll(){
  var items=[];
  __CHATS__.forEach(function(c){var key="c"+c.id,raw=__mx.keyChat[key];if(raw!=null&&__mx.pcount[key]==null)items.push({key:key,raw:raw})});
  for(var i=0;i<items.length;i+=20){
    var b=items.slice(i,i+20),changed=[];
    try{var p=await __mxCall(48,{chatIds:b.map(function(x){return x.raw})});
      (p&&p.chats||[]).forEach(function(c){
        if(!c||typeof c.participantsCount!=="number")return;
        b.forEach(function(x){if(String(x.raw)===String(c.id)){var ch=__mxSetCount(x.key,c.participantsCount);if(ch)changed.push(ch)}})});
      if(changed.length)__mxPublish([],changed);__mxLog("counts batch",i/20+1,"запрошено",b.length,"обновлено",changed.length)}catch(e){__mxLog("counts failed",e)}}
  __mxLog("counts done, чатов:",items.length)}
var __mxSyncC0=__mxSync;
__mxSync=function(){return __mxSyncC0().then(function(x){if(!__mx.cntRun){__mx.cntRun=1;__mxCountsAll().catch(function(){})}return x})};
async function __mxGetFullChat(e){
  await __mxSync();
  var key="c"+e.chat_id,raw=__mx.keyChat[key],r=__TBL__["messages.getFullChat"](e),n=raw!=null?await __mxCountFor(raw,key):null;
  if(n!=null){r.full_chat.participants_count=n;var ch=__mxSetCount(key,n);if(ch)__mxPublish([],[ch])}
  return r}
/* ---- стикеры MAX: opcode 27 (секции), 26 (страницы), 28 (паки и стикеры); отправка — attach STICKER в opcode 64 ---- */
__mx.st={p:null,setIds:[],sets:{},items:{},recent:[]};
function __mxChunk(a,n){var r=[];for(var i=0;i<a.length;i+=n)r.push(a.slice(i,i+n));return r}
function __mxStickersLoad(){
  if(__mx.st.p)return __mx.st.p;
  __mx.st.p=(async function(){
    var st=__mx.st,ids=[],marker=0,p=await __mxCall(27,{type:"STICKER",sync:0});
    ((p&&p.sections)||[]).forEach(function(s){
      if(!s||typeof s!=="object")return;
      if(s.id==="NEW_STICKER_SETS"&&Array.isArray(s.stickerSets)){ids.push.apply(ids,s.stickerSets);if(typeof s.marker==="number")marker=s.marker}
      else if(s.type==="RECENTS"&&Array.isArray(s.recentsList))st.recent=s.recentsList.filter(function(e){return e&&e.type==="STICKER"&&(typeof e.stickerId==="number"||typeof e.id==="number")}).map(function(e){return e.stickerId!=null?e.stickerId:e.id})});
    for(var pg=0;marker&&pg<10;pg++){
      var q=await __mxCall(26,{sectionId:"NEW_STICKER_SETS",from:marker,count:100}),l=(q&&q.stickerSets)||[];
      if(!l.length)break;ids.push.apply(ids,l);marker=q&&typeof q.marker==="number"?q.marker:0}
    var uniq=[];ids.forEach(function(i){if(uniq.indexOf(i)<0)uniq.push(i)});
    var ch=__mxChunk(uniq,30);
    for(var c=0;c<ch.length;c++){
      var r=await __mxCall(28,{type:"STICKER_SET",ids:ch[c]});
      ((r&&r.stickerSets)||[]).forEach(function(s){if(s&&typeof s.id==="number")st.sets[s.id]={id:s.id,name:s.name||"",iconUrl:s.iconUrl||"",stickers:Array.isArray(s.stickers)?s.stickers:[]}})}
    st.setIds=uniq.filter(function(i){return st.sets[i]});
    __mxLog("stickers: паков",st.setIds.length,"недавних",st.recent.length);
    if(!st.setIds.length)__mxLog("stickers: пустой ответ opcode 27:",JSON.stringify(p).slice(0,400))})().catch(function(e){__mxLog("stickers load failed",e);__mx.st.p=null;throw e});
  return __mx.st.p}
async function __mxStickerItems(ids){
  var st=__mx.st,need=ids.filter(function(i){return!st.items[i]}),ch=__mxChunk(need,50);
  for(var c=0;c<ch.length;c++){
    var r=await __mxCall(28,{type:"STICKER",ids:ch[c]});
    ((r&&r.stickers)||[]).forEach(function(s){if(s&&typeof s.id==="number")st.items[s.id]={id:s.id,url:s.url||"",lottieUrl:s.lottieUrl||null,stickerType:s.stickerType||null,width:s.width||170,height:s.height||170,tags:Array.isArray(s.tags)?s.tags:[]}})}}
function __mxStickerDoc(it,setId){
  var id=String(it.id),alt="🙂",i;
  for(i=0;i<(it.tags||[]).length;i++){if(/\p{Extended_Pictographic}/u.test(it.tags[i])){alt=it.tags[i];break}}
  var ss=setId!=null?{_:"inputStickerSetID",id:String(setId),access_hash:"1"}:{_:"inputStickerSetEmpty"};
  var lot=it.lottieUrl&&(!it.stickerType||it.stickerType==="LOTTIE")?it.lottieUrl:null;
  __mx.media[id]={kind:"STICKER",chatId:0,msgId:"",msgTime:0,idx:0,attach:{url:it.url},url:it.url,size:0,stickerId:it.id,lottie:lot};
  return{_:"document",pFlags:{},id:id,access_hash:"1",file_reference:[],date:1,mime_type:lot?"application/x-tgsticker":"image/webp",size:0,dc_id:2,attributes:[{_:"documentAttributeImageSize",w:it.width||170,h:it.height||170},{_:"documentAttributeSticker",pFlags:{},alt:alt,stickerset:ss},{_:"documentAttributeFilename",file_name:lot?"sticker.tgs":"sticker.webp"}]}}
function __mxSetObj(s){
  var o={_:"stickerSet",pFlags:{},id:String(s.id),access_hash:"1",title:s.name||("Стикеры "+s.id),short_name:"mx"+s.id,count:s.stickers.length,hash:1,installed_date:1};
  if(s.iconUrl){o.thumbs=[{_:"photoSize",type:"s",w:100,h:100,size:0}];o.thumb_dc_id=2;o.thumb_version=1}
  return o}
async function __mxGetAllStickers(){
  try{await __mxSync();await __mxStickersLoad()}catch(e){return{_:"messages.allStickers",hash:"1",sets:[]}}
  var st=__mx.st;__mxLog("getAllStickers: наборов",st.setIds.length);return{_:"messages.allStickers",hash:"1",sets:st.setIds.map(function(i){return __mxSetObj(st.sets[i])})}}
async function __mxGetStickerSet(e){
  var ss=e&&e.stickerset,bad={code:400,type:"STICKERSET_INVALID",handled:!0};
  if(!ss||ss._!=="inputStickerSetID")throw bad;
  try{await __mxStickersLoad()}catch(er){throw bad}
  var s=__mx.st.sets[ss.id];if(!s)throw bad;
  try{await __mxStickerItems(s.stickers)}catch(er){throw bad}
  var docs=[],packs={};
  s.stickers.forEach(function(i){var it=__mx.st.items[i];if(!it)return;var d=__mxStickerDoc(it,s.id),em=d.attributes[1].alt;docs.push(d);(packs[em]||(packs[em]=[])).push(d.id)});
  return{_:"messages.stickerSet",set:__mxSetObj(s),packs:Object.keys(packs).map(function(em){return{_:"stickerPack",emoticon:em,documents:packs[em]}}),keywords:[],documents:docs}}
async function __mxGetRecentStickers(){
  var empty={_:"messages.recentStickers",hash:"1",packs:[],stickers:[],dates:[]};
  try{await __mxSync();await __mxStickersLoad();var ids=__mx.st.recent.slice(0,40);await __mxStickerItems(ids);
    var docs=ids.map(function(i){var it=__mx.st.items[i];return it?__mxStickerDoc(it,null):null}).filter(Boolean);
    return{_:"messages.recentStickers",hash:"1",packs:[],stickers:docs,dates:docs.map(function(){return 1})}}catch(e){return empty}}
async function __mxSendSticker(e,key,cid,im){
  var did=String(im.id&&im.id.id),rec=__mx.media[did];
  __mxLog("send sticker",did,rec&&rec.stickerId);
  if(!rec||rec.stickerId==null)throw{code:400,type:"MEDIA_INVALID",handled:!0};
  var it=__mx.st.items[rec.stickerId]||{id:rec.stickerId,url:rec.url,width:170,height:170,tags:[]},date=Math.floor(Date.now()/1e3),
    o=__Q__(key,!0,"",0,__TC__,{media:{_:"messageMediaDocument",pFlags:{},document:__mxStickerDoc(it,null)}});
  (__mx.sentOut[key]||(__mx.sentOut[key]=[])).push({text:"",o:o});
  (async function(){
    try{var p=await __mxCall(64,{chatId:cid,message:{text:"",cid:Date.now(),attaches:[{_type:"STICKER",stickerId:Number(rec.stickerId)}]},notify:!0}),mm=p&&(p.message||p),mid=mm&&mm.id;
      if(mid!=null){(__mx.seen[key]||(__mx.seen[key]={}))[String(mid)]=1;__mx.tgIdOf[String(mid)]=o.id;__mx.maxIdOf[o.id]=String(mid)}
    }catch(er){__mxLog("send sticker failed",er)}
    var l=__mx.sentOut[key],i=l?l.findIndex(function(x){return x.o===o}):-1;if(i>=0)l.splice(i,1)})();
  return{_:"updates",updates:[{_:"updateMessageID",id:o.id,random_id:e.random_id},{_:"updateNewMessage",message:o,pts:++__NC__,pts_count:1}],users:[],chats:[],date:date,seq:0}}
/* ---- заглушки, на которых падал Web K (см. консоль) ---- */
function __mxSearchCounters(e){return(e&&e.filters||[]).map(function(f){return{_:"messages.searchCounter",pFlags:{},filter:f,count:0}})}
function __mxPaidPrivacy(){return{_:"updates",updates:[{_:"updatePaidReactionPrivacy",private:{_:"paidReactionPrivacyDefault"}}],users:[],chats:[],date:Math.floor(Date.now()/1e3),seq:0}}
async function __mxGetStickersByEmoji(e){
  var em=String(e&&e.emoticon||"").replace(/\uFE0F/g,""),docs=[];
  try{await __mxSync();await __mxStickersLoad()}catch(er){}
  var st=__mx.st;
  if(em)Object.keys(st.items).forEach(function(k){
    if(docs.length>=30)return;var it=st.items[k];
    if((it.tags||[]).some(function(t){t=String(t).replace(/\uFE0F/g,"");return t&&(em.indexOf(t)>=0||t.indexOf(em)>=0)}))docs.push(__mxStickerDoc(it,null))});
  return{_:"messages.stickers",hash:"1",stickers:docs}}
/* Таблица методов с приоритетом над заглушкой Web K */
var __mxM={
  "upload.getFile":__mxGetFile3,
  "upload.saveFilePart":__mxSavePart,
  "upload.saveBigFilePart":__mxSavePart,
  "messages.sendMedia":__mxSendMedia,
  "messages.toggleDialogPin":__mxToggleDialogPin,
  "messages.updatePinnedMessage":__mxUpdatePinned,
  "messages.reorderPinnedDialogs":function(){return!0},
  "messages.transcribeAudio":__mxTranscribe,
  "messages.getFullChat":__mxGetFullChat,
  "messages.getSearchCounters":__mxSearchCounters,
  "messages.getPaidReactionPrivacy":__mxPaidPrivacy,
  "messages.getStickers":__mxGetStickersByEmoji,
  "channels.getChannelRecommendations":function(){return{_:"messages.chats",chats:[]}},
  "messages.getAllStickers":__mxGetAllStickers,
  "messages.getStickerSet":__mxGetStickerSet,
  "messages.getRecentStickers":__mxGetRecentStickers,
  "messages.saveRecentSticker":function(){return!0},
  "messages.installStickerSet":function(){return{_:"messages.stickerSetInstallResultSuccess"}},
  "messages.uninstallStickerSet":function(){return!0},
  "help.getAppConfig":__mxAppConfig,
  "help.getPremiumPromo":function(){throw{code:400,type:"PREMIUM_PROMO_UNAVAILABLE",handled:!0}}
};
/* ==== конец ext3 ==== */
