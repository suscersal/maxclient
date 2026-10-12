/* ==== MAX adapter ext2: поиск, пресенс, каналы без отправителя, неизвестные отправители ==== */
__mx.chType=__mx.chType||{};__mx.fetchU={};
function __mxPublish(users,chats){try{__IC__({_:"updates",updates:[],users:users||[],chats:chats||[],date:Math.floor(Date.now()/1e3),seq:0})}catch(e){__mxLog("publish failed",e)}}
function __mxReg(key,cid){__mx.keyChat[key]=cid;__mx.chatKey[cid]=key}
/* Незнакомые отправители в группах: подтягиваем имена одним запросом (opcode 32). */
function __mxFetchUsers(ids){
  var miss=ids.filter(function(i){return i!=null&&!__mx.contacts[i]&&!__mx.fetchU[i]});
  if(!miss.length)return;miss.forEach(function(i){__mx.fetchU[i]=1});
  __mxCall(32,{contactIds:miss.map(Number)}).then(function(r){var us=[];(r.contacts||[]).forEach(function(c){__mx.contacts[c.id]=c;us.push(__mxUser(c.id))});__mxPublish(us,[])}).catch(function(){})}
async function __mxSearchMsgs(e){
  var q=(e.q||"").toLowerCase(),lim=e.limit||20,empty={_:"messages.messages",messages:[],chats:[],users:[]};
  if(!q||(e.filter&&e.filter._&&e.filter._!=="inputMessagesFilterEmpty"))return empty;
  var single=e.peer&&e.peer._&&e.peer._!=="inputPeerEmpty",keys;
  await __mxSync();
  if(single){keys=[__UC__(e.peer)];await __mxLoad(keys[0])}else keys=Object.keys(__FC__);
  var out=[];keys.forEach(function(k){(__FC__[k]||[]).forEach(function(m){if(m.message&&m.message.toLowerCase().indexOf(q)>=0)out.push(m)})});
  out.sort(function(a,b){return b.date-a.date||b.id-a.id});
  if(e.offset_id)out=out.filter(function(m){return m.id<e.offset_id});
  var n=out.length;out=out.slice(0,lim);
  return{_:"messages.messagesSlice",pFlags:{},count:n,messages:out,chats:__LC__,users:__CC__}}
function __mxChatObj(ch){
  return{_:"chat",pFlags:{},id:Math.abs(ch.id),title:ch.title||("Чат #"+ch.id),photo:{_:"chatPhotoEmpty"},participants_count:ch.participantsCount||2,date:Math.floor((ch.created||Date.now())/1e3),version:1}}
async function __mxFound(e){
  var q=(e.q||"").trim(),ql=q.toLowerCase().replace(/^@/,""),my=[],res=[],seenP={},newU=[],newC=[];
  var found=function(){__mxPublish(newU,newC);return{_:"contacts.found",my_results:my,results:res,chats:__LC__,users:__CC__}};
  if(!ql)return found();
  await __mxSync();
  __CC__.forEach(function(u){if(u.id===__TC__)return;var n=((u.first_name||"")+" "+(u.last_name||"")).toLowerCase();if(n.indexOf(ql)>=0){my.push({_:"peerUser",user_id:u.id});seenP["u"+u.id]=1}});
  __LC__.forEach(function(c){if((c.title||"").toLowerCase().indexOf(ql)>=0){my.push({_:"peerChat",chat_id:c.id});seenP["c"+c.id]=1}});
  var digits=q.replace(/\D/g,""),compact=q.replace(/[\s+()-]/g,"");
  try{
    if(digits.length>=5&&digits.length>=compact.length*0.8){
      var r=await __mxCall(46,{phone:"+"+digits}),c=r&&r.contact;
      if(c&&typeof c.id==="number"){__mx.contacts[c.id]=c;var u=__mxUser(c.id),k="u"+u.id;newU.push(u);
        if(__mx.keyChat[k]==null)__mxReg(k,Number(BigInt(__mx.self)^BigInt(c.id)));
        if(!seenP[k])res.push({_:"peerUser",user_id:u.id})}
    }else{
      var r2=await __mxCall(60,{type:"ALL",count:20,query:ql});
      (r2&&r2.result||[]).forEach(function(it){var ch=it&&it.chat;if(!ch||typeof ch.id!=="number"||ch.type==="DIALOG")return;
        var k=__mxKey(ch);__mxReg(k,ch.id);__mx.chType[k]=ch.type;
        if(__mx.iconOf&&ch.baseIconUrl)__mx.iconOf[Math.abs(ch.id)]=ch.baseIconUrl;
        if(!__LC__.some(function(x){return"c"+x.id===k})){var o=__mxChatObj(ch);__LC__.push(o);newC.push(o)}
        if(!seenP[k])res.push({_:"peerChat",chat_id:Math.abs(ch.id)})})}
  }catch(err){__mxLog("search failed",err)}
  return found()}
async function __mxResolvePhone(e){
  await __mxSync();var digits=String(e.phone||"").replace(/\D/g,"");
  var r=await __mxCall(46,{phone:"+"+digits}).catch(function(){return null}),c=r&&r.contact;
  if(!c||typeof c.id!=="number")throw{code:400,type:"PHONE_NOT_OCCUPIED",handled:!0};
  __mx.contacts[c.id]=c;var u=__mxUser(c.id),k="u"+u.id;if(__mx.keyChat[k]==null)__mxReg(k,Number(BigInt(__mx.self)^BigInt(c.id)));
  __mxPublish([u],[]);return{_:"contacts.resolvedPeer",peer:{_:"peerUser",user_id:u.id},chats:__LC__,users:__CC__}}
async function __mxResolveName(e){
  await __mxSync();var f=await __mxFound({q:e.username||""});
  var p=(f.results[0]||f.my_results[0]);if(!p)throw{code:400,type:"USERNAME_NOT_OCCUPIED",handled:!0};
  return{_:"contacts.resolvedPeer",peer:p,chats:__LC__,users:__CC__}}
/* ==== конец ext2 ==== */
