'use strict';
/* Thin client: the server owns the rules and only ever sends you your own cards. */

const SUITS=['S','H','D','C'];
const GLYPH={S:'♠',H:'♥',D:'♦',C:'♣'};
const SUITNAME={S:'Spades',H:'Hearts',D:'Diamonds',C:'Clubs'};
const RED={H:1,D:1};
const quotaFor=b=>b/5;
const el=id=>document.getElementById(id);

let ws=null, V=null, discardSel=new Set(), connected=false, myToken=null;
let dealKey=null, dealAt=0;          // which hand we last animated, and when

const store={
  get token(){ try{ return localStorage.getItem('f45.token'); }catch{ return null; } },
  set token(v){ try{ localStorage.setItem('f45.token', v); }catch{} },
  get name(){ try{ return localStorage.getItem('f45.name')||''; }catch{ return ''; } },
  set name(v){ try{ localStorage.setItem('f45.name', v); }catch{} },
  get lastCode(){ try{ return localStorage.getItem('f45.lastCode')||''; }catch{ return ''; } },
  set lastCode(v){ try{ localStorage.setItem('f45.lastCode', v); }catch{} }
};

const roomFromUrl=()=>{
  const m=location.pathname.match(/\/t\/([A-Za-z0-9]{4})/);
  if(m) return m[1].toUpperCase();
  const q=new URLSearchParams(location.search).get('table');
  return q?q.toUpperCase():null;
};

/* ---------------- socket ---------------- */
function connect(then){
  const proto=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(proto+'//'+location.host);
  ws.onopen=()=>{ connected=true; banner(false); then&&then(); };
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.type==='state'){
      const key=V2key(m.view);
      if(key && key!==dealKey){ dealKey=key; dealAt=Date.now(); }
      V=m.view; render();
      if(dealing()){ clearTimeout(window.__settle); window.__settle=setTimeout(render,1700); }
    }
    else if(m.type==='joined'){
      myToken=m.token; store.token=m.token; store.lastCode=m.code;
      history.replaceState({}, '', '/t/'+m.code);
    }
    else if(m.type==='error') showError(m.message);
  };
  ws.onclose=()=>{ connected=false; banner(true); setTimeout(()=>connect(rejoin),1500); };
  ws.onerror=()=>{};
}
const send=o=>{ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); };
function rejoin(){
  const code=roomFromUrl();
  if(code) send({type:'join', code, token:store.token, name:store.name||'Player'});
}
function banner(show){
  let b=document.querySelector('.conn');
  if(show&&!b){ b=document.createElement('div'); b.className='conn'; b.textContent='Reconnecting…'; document.body.appendChild(b); }
  if(!show&&b) b.remove();
}

// A hand is "freshly dealt" for the length of the dealing animation.
const V2key=v=>(v && v.code && v.handNo) ? v.code+'#'+v.handNo : null;

/* Where each card sits in the 3-then-2 (or 2-then-3) rhythm, so the animation
   matches how the cards actually came off the deck. */
function dealDelays(){
  const pat=(V && V.dealPattern) || [3,2];
  const seatOrder=[0,1,2,3].map(k=>(V.dealer+1+k)%4);
  const packet=[];                       // one entry per packet, in dealing order
  for(const chunk of pat) for(const seat of seatOrder) packet.push({seat, chunk});
  const perSeat={};
  packet.forEach((p,i)=>{
    (perSeat[p.seat]=perSeat[p.seat]||[]).push({at:i*170, n:p.chunk});
  });
  return perSeat;
}
const dealing=()=>V && V.handNo && (Date.now()-dealAt) < 1600;

/* ---------------- card markup ---------------- */
function cardHTML(c,{small,trump,cls,tag}={}){
  return '<span class="card'+(small?' sm':'')+(RED[c.s]?' red':'')+(trump?' trump':'')+(cls?' '+cls:'')+'">'+
    '<span class="corner"><span class="r">'+c.r+'</span><span class="s">'+GLYPH[c.s]+'</span></span>'+
    '<span class="big">'+GLYPH[c.s]+'</span></span>';
}
const cardText=c=>c.r+GLYPH[c.s];
// Your seat always sits at the bottom; the other three rotate round you.
const screenPos=seat=>V.mySeat===null?seat:(seat-V.mySeat+4)%4;
const seatAt=pos=>V.mySeat===null?pos:(V.mySeat+pos)%4;
const teamOf=s=>s%2;

/* ---------------- render ---------------- */
function render(){
  if(!V) return;
  if(V.phase==='lobby'){ renderLobby(); return; }
  closeOverlayIf(['lobby','error']);

  const myTurn = V.mySeat!==null && (
      (V.phase==='bidding'&&V.turn===V.mySeat) ||
      (V.phase==='playing'&&V.turn===V.mySeat&&V.legal&&V.legal.length) ||
      (V.phase==='naming'&&V.highBid.seat===V.mySeat) ||
      (V.phase==='drawing'&&V.drawers.includes(V.mySeat)&&!V.iAmReady) || !!V.mustPlay);
  document.querySelector('.board').classList.toggle('myturn', !!myTurn);
  el('tableTag').textContent='Table '+V.code;
  let banner=document.getElementById('turnbanner');
  if(!banner){
    banner=document.createElement('div');
    banner.id='turnbanner'; banner.className='turnbanner';
    document.querySelector('.well').appendChild(banner);
  }
  banner.textContent='Your turn';
  banner.hidden=!myTurn;
  el('btnInvite').hidden=false;
  el('btnSettings').hidden=!V.isHost;

  const myTeam=V.mySeat===null?0:teamOf(V.mySeat);
  el('scoreUs').textContent=V.scores[myTeam];
  el('scoreThem').textContent=V.scores[1-myTeam];
  el('subUs').textContent=teamNames(myTeam);
  el('subThem').textContent=teamNames(1-myTeam);
  el('targetNote').textContent='First to '+V.settings.target+' points';

  renderSeats();
  renderWell();
  renderUnits(myTeam);
  renderContract();
  el('log').innerHTML=V.log.map(l=>'<p class="'+l.cls+'">'+l.html+'</p>').join('');
  renderHand();
  renderPromptAndBar();
  if(V.phase==='handover'||V.phase==='gameover') showResult();
}

const nameOf=s=>{
  const p=V.seats[s];
  if(!p) return 'Seat '+(s+1);
  if(p.empty) return 'Bot '+(s+1);
  return p.name+(p.away?'':'');
};
const teamNames=t=>[0,1,2,3].filter(s=>teamOf(s)===t).map(nameOf).join(' + ');

function renderSeats(){
  for(let pos=0;pos<4;pos++){
    const seat=seatAt(pos), box=el('seatBox'+pos), p=V.seats[seat];
    const isTurn=((V.phase==='bidding'||V.phase==='playing')&&V.turn===seat)
               ||(V.phase==='drawing'&&V.drawingWho===seat);
    let chip='';
    if(V.phase==='bidding'||V.phase==='naming'){
      const b=V.bids[seat];
      if(b==='pass') chip+='<span class="chip-bid pass">pass</span>';
      else if(b) chip+='<span class="chip-bid">'+b+'</span>';
    }else if(V.highBid&&V.highBid.seat===seat){
      chip+='<span class="chip-bid">'+V.highBid.value+' '+(V.trump?GLYPH[V.trump]:'')+'</span>';
    }
    const di=V.drawInfo&&V.drawInfo[seat];
    if(di) chip+='<span class="chip-bid draw">kept '+di.kept+' · drew '+di.drew+'</span>';
    else if(V.phase==='drawing'&&V.drawers.includes(seat))
      chip+='<span class="chip-bid draw">'+(V.ready[seat]?'ready':'choosing…')+'</span>';

    const roles=[];
    if(seat===V.dealer) roles.push('deals');
    if(V.mySeat!==null&&seat===(V.mySeat+2)%4) roles.push('partner');
    const dot=p.empty?'bot':p.away?'away':'';
    const mine=V.mySeat!==null&&teamOf(seat)===teamOf(V.mySeat);
    const plate='<div class="plate'+(isTurn?' active':'')+(mine?' us':'')+'">'+
      '<span class="dot '+dot+'"></span>'+
      '<span class="avatar">'+nameOf(seat).slice(0,1).toUpperCase()+'</span>'+
      '<span class="pname">'+(seat===V.mySeat?'You':nameOf(seat))+'</span>'+
      (roles.length?'<span class="prole">'+roles.join(' · ')+'</span>':'')+chip+'</div>';

    if(pos===0){ box.innerHTML=plate; continue; }
    const vert=(pos===1||pos===3);
    const an=dealing()&&V.phase==='bidding'?dealDelays()[seat]:null;
    const dirs={1:[-200,0],2:[0,220],3:[200,0]};
    const backs='<div class="backs'+(vert?' vert':'')+'">'+
      Array.from({length:V.counts[seat]||0},(_,idx)=>{
        if(!an) return '<span class="back"></span>';
        let acc=0, at=0;
        for(const p of an){ if(idx<acc+p.n){ at=p.at; break; } acc+=p.n; }
        const d=dirs[pos]||[0,0];
        return '<span class="back dealt" style="animation-delay:'+at+'ms;--dx:'+d[0]+'px;--dy:'+d[1]+'px"></span>';
      }).join('')+'</div>';
    box.innerHTML = pos===2 ? plate+backs : backs+plate;
  }
}

function renderWell(){
  if(V.decl){
    for(let pos=0;pos<4;pos++){
      const seat=seatAt(pos), slot=el('slot'+pos);
      const cards=V.decl.cards[seat]||[];
      slot.innerHTML=cards.length
        ? '<div class="stack">'+cards.map(c=>cardHTML(c,{small:true,trump:isTrumpC(c),cls:'played'})).join('')+
          (seat===V.decl.leader?'<span class="tag led">declared</span>':'')+'</div>'
        : '';
    }
    el('wellinfo').innerHTML='<span class="lbl">Declared</span>'+
      '<span class="trumpmark'+(RED[V.trump]?' red':'')+'">'+GLYPH[V.trump]+'</span>'+
      '<span class="trumpname">'+V.decl.count+' tricks</span>'+
      '<span class="lbl">'+nameOf(V.decl.leader)+'</span>';
    return;
  }
  for(let pos=0;pos<4;pos++){
    const seat=seatAt(pos), slot=el('slot'+pos);
    const play=V.trick.find(x=>x.seat===seat);
    if(!play){ slot.innerHTML=''; continue; }
    const led=V.trick[0].seat===seat;
    const taking=V.trick.length>1&&localWinner(V.trick).seat===seat;
    slot.innerHTML='<div class="playwrap">'+
      cardHTML(play.card,{small:true,trump:V.trump&&isTrumpC(play.card),cls:'played'})+
      (led?'<span class="tag led">led</span>':taking?'<span class="tag taking">taking</span>':'')+'</div>';
  }
  const wi=el('wellinfo');
  if(V.phase==='shuffling'){
    wi.innerHTML='<span class="lbl">Shuffling</span><div class="shuffle">'+
      '<span class="back"></span><span class="back"></span><span class="back"></span><span class="back"></span></div>'+
      '<span class="trumpname">'+nameOf(V.dealer)+' deals</span>';
  }else if(V.trump){
    wi.innerHTML='<span class="lbl">Trump</span>'+
      '<span class="trumpmark'+(RED[V.trump]?' red':'')+'">'+GLYPH[V.trump]+'</span>'+
      '<span class="trumpname">'+SUITNAME[V.trump]+'</span>'+
      '<span class="lbl">Trick '+Math.min(V.trickNo+1,5)+' of 5</span>';
  }else if(V.phase==='bidding'){
    wi.innerHTML='<span class="lbl">Auction</span><span class="trumpname">'+
      (V.highBid?nameOf(V.highBid.seat)+' at '+V.highBid.value:'no bid yet')+'</span>';
  }else if(V.phase==='naming'){
    wi.innerHTML='<span class="lbl">Naming trump</span><span class="trumpname">'+nameOf(V.highBid.seat)+'</span>';
  }else wi.innerHTML='<span class="lbl">Dealing</span>';
}

/* Client-side mirror of trick resolution, for the "taking" tag only. */
const TRUMP_ORDER={
  S:['5S','JS','AH','AS','KS','QS','2S','3S','4S','6S','7S','8S','9S','10S'],
  C:['5C','JC','AH','AC','KC','QC','2C','3C','4C','6C','7C','8C','9C','10C'],
  D:['5D','JD','AH','AD','KD','QD','10D','9D','8D','7D','6D','4D','3D','2D'],
  H:['5H','JH','AH','KH','QH','10H','9H','8H','7H','6H','4H','3H','2H']};
const PLAIN_ORDER={
  S:['KS','QS','JS','AS','2S','3S','4S','5S','6S','7S','8S','9S','10S'],
  C:['KC','QC','JC','AC','2C','3C','4C','5C','6C','7C','8C','9C','10C'],
  D:['KD','QD','JD','10D','9D','8D','7D','6D','5D','4D','3D','2D','AD'],
  H:['KH','QH','JH','10H','9H','8H','7H','6H','5H','4H','3H','2H']};
const isTrumpC=c=>c.s===V.trump||c.id==='AH';
const powerC=c=>isTrumpC(c)
  ? 1000+(TRUMP_ORDER[V.trump].length-TRUMP_ORDER[V.trump].indexOf(c.id))
  : (PLAIN_ORDER[c.s].length-PLAIN_ORDER[c.s].indexOf(c.id));
const effC=c=>isTrumpC(c)?V.trump:c.s;
function localWinner(trick){
  const ledSuit=effC(trick[0].card);
  const trumps=trick.filter(p=>isTrumpC(p.card));
  const pool=trumps.length?trumps:trick.filter(p=>effC(p.card)===ledSuit);
  let best=null;
  for(const p of pool) if(!best||powerC(p.card)>powerC(best.card)) best=p;
  return best;
}

function renderUnits(myTeam){
  const quota=V.highBid?quotaFor(V.highBid.value):0;
  const bt=V.highBid?teamOf(V.highBid.seat):null;
  const us=V.units[myTeam], them=V.units[1-myTeam];
  const htTeam=V.highTrumpSeat===null||V.highTrumpSeat===undefined?null:teamOf(V.highTrumpSeat);
  let cells='';
  for(let i=0;i<5;i++){
    let cls='unit';
    if(i<us) cls+=' us'; else if(i<us+them) cls+=' them';
    if(bt!==null&&i<quota) cls+=' quota';
    cells+='<div class="'+cls+'">'+(i+1)+'</div>';
  }
  const hc='unit'+(htTeam===null?'':htTeam===myTeam?' us':' them')+(bt!==null&&quota===6?' quota':'');
  cells+='<div class="'+hc+'">high</div>';
  el('units').innerHTML=cells;
  el('unitQuota').textContent=V.highBid?('quota '+quota):'';
  el('unitLeft').textContent='Us '+(us+(htTeam===myTeam?1:0))+' · Them '+(them+(htTeam!==null&&htTeam!==myTeam?1:0));
}

function renderContract(){
  const ct=el('contract');
  if(V.highBid&&V.trump){
    const bt=teamOf(V.highBid.seat), needed=quotaFor(V.highBid.value);
    const ht=V.highTrumpSeat===null||V.highTrumpSeat===undefined?null:teamOf(V.highTrumpSeat);
    const got=V.units[bt]+(ht===bt?1:0);
    ct.className='contract';
    ct.innerHTML=
      '<div class="line"><span>Contract</span><b>'+V.highBid.value+' · '+SUITNAME[V.trump]+' '+GLYPH[V.trump]+'</b></div>'+
      '<div class="line"><span>Bidder</span><b>'+nameOf(V.highBid.seat)+'</b></div>'+
      '<div class="line"><span>Needs</span><b>'+needed+' of 6</b></div>'+
      '<div class="line"><span>Has</span><b>'+got+'</b></div>'+
      '<div class="line"><span>Dealer</span><b>'+nameOf(V.dealer)+'</b></div>';
  }else{
    ct.className='contract idle';
    ct.innerHTML='<div class="line"><span>Contract</span><b>'+(V.phase==='bidding'?'auction open':'—')+'</b></div>'+
      '<div class="line"><span>Dealer</span><b>'+nameOf(V.dealer)+'</b></div>'+
      '<div class="line"><span>Opens bidding</span><b>'+nameOf((V.dealer+1)%4)+'</b></div>';
  }
}

function renderHand(){
  const h=el('hand');
  if(V.mySeat===null||!V.hand){ h.innerHTML=''; return; }
  const discarding=V.phase==='drawing'&&V.drawers.includes(V.mySeat)&&!V.iAmReady;
  const contributing=!!V.mustPlay;
  const anim=dealing()&&V.phase==='bidding'?dealDelays()[V.mySeat]:null;
  let given=0;
  h.className='hand'+(V.legal&&V.legal.length?' live':'');
  h.innerHTML=V.hand.map((c,idx)=>{
    let cls='';
    if(discarding||contributing) cls='playable'+(discardSel.has(c.id)?' picked':'');
    else if(V.legal) cls=V.legal.includes(c.id)?'playable':'blocked';
    const disabled=!contributing&&V.legal&&!V.legal.includes(c.id);
    let style='';
    if(anim){
      // find which packet this card arrived in
      let acc=0, at=0;
      for(const p of anim){ if(idx<acc+p.n){ at=p.at; break; } acc+=p.n; }
      cls+=' dealt';
      style=' style="animation-delay:'+at+'ms;--dx:'+((idx-2)*18)+'px;--dy:-260px;--dr:'+((idx-2)*4)+'deg"';
    }
    return cardHTML(c,{trump:V.trump&&isTrumpC(c),cls})
      .replace('<span class="card','<button type="button" data-id="'+c.id+'"'+(disabled?' disabled':'')+style+' class="card')
      .replace(/<\/span>$/,'</button>');
  }).join('');
  h.querySelectorAll('button[data-id]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.id;
    if(contributing){                       // choosing cards for someone's declaration
      if(discardSel.has(id)) discardSel.delete(id);
      else if(discardSel.size < V.mustPlay.count) discardSel.add(id);
      renderHand(); renderPromptAndBar(); return;
    }
    if(discarding){
      discardSel.has(id)?discardSel.delete(id):discardSel.add(id);
      renderHand(); renderPromptAndBar(); return;
    }
    if(!V.legal||!V.legal.includes(id)) return;
    send({type:'play', cardId:id});
  });
}

function renderPromptAndBar(){
  const note=el('handnote'), bar=el('actionbar');
  let cue='', btns='', msg='&nbsp;';
  const me=V.mySeat;

  if(me===null){ msg='Watching — all four seats are taken.'; }
  else if(V.phase==='bidding'&&V.turn===me){
    const cur=V.highBid?V.highBid.value:0;
    const list=[15,20,25,30].filter(b=>b>cur);
    const canHold=V.settings.dealerHold&&me===V.dealer&&V.highBid&&cur<30;
    cue='<span class="cue">'+(V.highBid?nameOf(V.highBid.seat)+' in at <b>'+cur+'</b>':'Your call')+'</span>';
    btns=list.map(b=>'<button class="btn" data-act="bid" data-v="'+b+'">'+b+
         ' <span style="opacity:.65;font-weight:400">'+quotaFor(b)+'/6</span></button>').join('')+
         (canHold?'<button class="btn" data-act="hold">Hold at '+cur+'</button>':'')+
         '<span class="sep"></span><button class="btn quiet" data-act="pass">Pass'+
         (!V.highBid&&V.dealer===me?' <span style="opacity:.7;font-weight:400">· stuck at 15</span>':'')+'</button>';
    msg='Your call.';
  }
  else if(V.phase==='naming'&&V.highBid.seat===me){
    cue='<span class="cue">'+(V.highBid.stuck?'Stuck at <b>15</b>':'Took it at <b>'+V.highBid.value+'</b>')+' — name trump</span>';
    btns=SUITS.map(s=>'<button class="btn suit'+(RED[s]?' red':'')+'" data-act="trump" data-v="'+s+'">'+
         GLYPH[s]+'<span class="nm">'+SUITNAME[s]+'</span></button>').join('');
    msg=(V.highBid.stuck?'Nobody bid, so it’s on you. ':'')+'You need <strong>'+quotaFor(V.highBid.value)+' of 6</strong>.';
  }
  else if(V.phase==='drawing'&&V.drawingWho===me){
    const n=discardSel.size;
    cue='<span class="cue">Click cards to throw away</span>';
    btns='<button class="btn solid" data-act="draw">'+(n?'Throw '+n+' &amp; draw '+n:'Stand pat')+'</button>'+
         (n?'<button class="btn quiet" data-act="clear">Clear</button>':'');
    msg='<strong>'+SUITNAME[V.trump]+' '+GLYPH[V.trump]+'</strong> is trump — keep what helps.';
  }
  else if(V.phase==='drawing'&&V.drawingWho!==null) msg='<strong>'+nameOf(V.drawingWho)+'</strong> is discarding.';
  else if(V.mustPlay){
    const need=V.mustPlay.count, t=V.mustPlay.trumps;
    const chosen=[...discardSel];
    const chosenTrumps=chosen.filter(id=>{const c=V.hand.find(x=>x.id===id);return c&&isTrumpC(c);}).length;
    const ok=chosen.length===need&&chosenTrumps===t;
    cue='<span class="cue">'+nameOf(V.decl.leader)+' declared — play <b>'+need+'</b>'+
        (t?', including <b>'+t+'</b> trump'+(t>1?'s':''):'')+'</span>';
    btns='<button class="btn solid" data-act="contrib"'+(ok?'':' disabled style="opacity:.45"')+'>'+
         'Play '+chosen.length+' of '+need+'</button>'+
         (chosen.length?'<button class="btn quiet" data-act="clear">Clear</button>':'');
    msg=t? 'You hold '+t+' trump'+(t>1?'s':'')+' — '+(t===1?'it has':'they have')+' to go in.'
         : 'No trumps — any '+need+' cards will do.';
  }
  else if(V.phase==='playing'&&V.turn===me){
    if(V.canDeclare){
      const names=V.canDeclare===3?'5 + J + A♥':'5 + J';
      cue='<span class="cue">Your lead</span>';
      btns='<button class="btn solid" data-act="declare" data-v="'+V.canDeclare+'">Lead '+names+
           ' together <span style="opacity:.7;font-weight:400">· '+V.canDeclare+' tricks</span></button>'+
           '<span class="sep"></span>';
    }
    msg=V.trick.length===0?'Your lead.'
      :(V.legal&&V.legal.length<V.hand.length
        ?'Follow <strong>'+(effC(V.trick[0].card)===V.trump?'trump '+GLYPH[V.trump]:SUITNAME[effC(V.trick[0].card)]+' '+GLYPH[effC(V.trick[0].card)])+'</strong>.'
        :'Play anything.');
  }
  else if(V.phase==='playing') msg='Waiting on <strong>'+nameOf(V.turn)+'</strong>.';
  else if(V.phase==='bidding') msg='Waiting on <strong>'+nameOf(V.turn)+'</strong>.';
  else if(V.phase==='naming') msg='<strong>'+nameOf(V.highBid.seat)+'</strong> is naming trump.';

  note.innerHTML=msg;
  if(!btns){ bar.hidden=true; bar.innerHTML=''; return; }
  bar.hidden=false; bar.innerHTML=cue+btns;
  bar.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.act;
    if(a==='bid') send({type:'bid', value:+b.dataset.v});
    else if(a==='hold') send({type:'bid', value:V.highBid.value, hold:true});
    else if(a==='pass') send({type:'bid', value:null});
    else if(a==='trump') send({type:'trump', suit:b.dataset.v});
    else if(a==='clear'){ discardSel.clear(); renderHand(); renderPromptAndBar(); }
    else if(a==='draw'){ send({type:'discard', ids:[...discardSel]}); discardSel.clear(); }
    else if(a==='declare'){ discardSel.clear(); send({type:'declare', count:+b.dataset.v}); }
    else if(a==='contrib'){ send({type:'contribute', ids:[...discardSel]}); discardSel.clear(); }
  });
}

/* ---------------- overlays ---------------- */
const ov=el('overlay');
let ovKind=null;
function paint(kind,html){ ovKind=kind; ov.innerHTML='<div class="scrim">'+html+'</div>'; }
function closeOv(){ ovKind=null; ov.innerHTML=''; }
function closeOverlayIf(kinds){ if(ovKind&&kinds.includes(ovKind)) closeOv(); }
function showError(message){
  paint('error','<div class="panel"><h3>Can’t join</h3><p class="dek">'+message+'</p>'+
    '<div class="row"><button class="btn solid" id="backHome">Start a new table</button></div></div>');
  el('backHome').onclick=()=>{ history.replaceState({},'','/'); ovKind=null; renderLobby(true); };
}

function renderLobby(force){
  if(ovKind==='lobby'&&!force) { paintLobby(); return; }
  paintLobby();
}
function paintLobby(){
  const code=V&&V.code?V.code:roomFromUrl();
  const host=V&&V.isHost;
  let body;

  if(V){
    // Seats alternate round the table, so partners sit across from each other.
    const rows=V.seats.map((p,i)=>{
      const mine=i===V.mySeat;
      const canSit=p.empty&&V.mySeat!==null&&!mine;
      return '<div class="seatrow'+(mine?' mine':'')+'">'+
        '<span class="tm">'+(i%2===0?'Team A':'Team B')+'</span>'+
        '<span class="nm'+(p.empty?' vacant':'')+'">'+
          (p.empty?'open — a bot will sit in':(mine?p.name+' (you)':p.name))+'</span>'+
        (p.away?'<span class="st">away</span>':'')+
        (canSit?'<button class="btn tiny" data-sit="'+i+'">Sit here</button>':'')+
        '</div>';
    }).join('');
    const myTeam=V.mySeat===null?null:(V.mySeat%2===0?'Team A':'Team B');
    body='<div class="panel"><h3>Table '+V.code+'</h3>'+
      '<p class="dek">Partners sit across the table — Team A is seats 1 and 3, Team B is seats 2 and 4. '+
      'Click any open seat to move; empty seats are played by bots.</p>'+
      '<div class="codebig">'+V.code+'</div>'+
      '<div class="row" style="justify-content:center;margin-bottom:12px">'+
        '<button class="btn" id="copyLink">Copy invite link</button></div>'+
      '<div class="seatlist">'+rows+'</div>'+
      (myTeam?'<p class="waiting" style="margin:10px 0 0">You’re on <b style="color:var(--sage)">'+myTeam+'</b></p>':'')+
      '<div class="row" style="margin-top:14px">'+
      (host?'<button class="btn solid" id="startBtn">Deal the first hand</button>'
           :'<span class="waiting">Waiting for the host to deal…</span>')+'</div></div>';
  } else {
    body='<div class="panel"><h3>Kitchen Table 45s</h3>'+
      '<p class="dek">Four players, two teams, six units a hand. Start a table and send the link to three friends — empty seats are covered by bots.</p>'+
      '<div class="lobby">'+
      '<label>Your name<input id="nm" maxlength="14" value="'+(store.name||'')+'" placeholder="Ajay"></label>'+
      (code?'<label>Table code<input id="code" value="'+code+'" maxlength="4"></label>':'')+
      '</div><div class="row" style="margin-top:16px">'+
      (code?'<button class="btn solid" id="joinBtn">Join table</button>':'')+
      '<button class="btn'+(code?' quiet':' solid')+'" id="newBtn">Start a new table</button>'+
      '</div></div>';
  }
  paint('lobby', body);

  const cp=el('copyLink'); if(cp) cp.onclick=copyInvite;
  const sb=el('startBtn'); if(sb) sb.onclick=()=>send({type:'start'});
  ov.querySelectorAll('[data-sit]').forEach(b=>b.onclick=()=>send({type:'sit', seat:+b.dataset.sit}));
  const jb=el('joinBtn');
  if(jb) jb.onclick=()=>{
    store.name=(el('nm').value||'Player').trim()||'Player';
    send({type:'join', code:el('code').value.trim().toUpperCase(), token:store.token, name:store.name});
  };
  const nb=el('newBtn');
  if(nb) nb.onclick=()=>{
    store.name=(el('nm')?el('nm').value:'').trim()||'Player';
    send({type:'create', name:store.name});
  };
}

function copyInvite(){
  const url=location.origin+'/t/'+V.code;
  navigator.clipboard?.writeText(url).then(()=>{
    const b=el('copyLink')||el('btnInvite');
    if(b){ const old=b.textContent; b.textContent='Link copied'; setTimeout(()=>b.textContent=old,1400); }
  }).catch(()=>prompt('Copy this link:', url));
}

function showResult(){
  if(ovKind==='result') return;
  const r=V.result; if(!r) return;
  const myTeam=V.mySeat===null?0:teamOf(V.mySeat);
  const label=t=>t===myTeam?'Us':'Them';
  const htName=r.htTeam===null?'nobody (no trump played)':label(r.htTeam);
  const verdict=V.phase==='gameover'
    ? (V.winner===myTeam?'Game. Your side gets there first.':'Game to the other side.')
    : (r.made?(r.units[r.bt]===6?'Clean sweep — all six.':'Contract made.'):'Set.');
  const rows=
    '<div class="resrow"><span class="k">Contract</span><span class="v">'+nameOf(r.bidderSeat)+' · '+r.bid+' · '+SUITNAME[r.trump]+' '+GLYPH[r.trump]+'</span></div>'+
    '<div class="resrow"><span class="k">Tricks</span><span class="v">Us '+r.tricks[myTeam]+' · Them '+r.tricks[1-myTeam]+'</span></div>'+
    '<div class="resrow"><span class="k">High trump</span><span class="v">'+(r.highTrump?cardText(r.highTrump)+' — '+htName:htName)+'</span></div>'+
    '<div class="resrow"><span class="k">Units</span><span class="v">Us '+r.units[myTeam]+' · Them '+r.units[1-myTeam]+' (needed '+r.quota+')</span></div>'+
    '<div class="resrow"><span class="k">'+label(r.bt)+' (bidders)</span><span class="v '+(r.bidDelta>=0?'good':'bad')+'">'+(r.bidDelta>=0?'+':'')+r.bidDelta+'</span></div>'+
    (V.settings.defendersScore?'<div class="resrow"><span class="k">'+label(r.dt)+'</span><span class="v">+'+r.defDelta+'</span></div>':'')+
    '<div class="resrow"><span class="k">Score</span><span class="v">Us '+V.scores[myTeam]+' · Them '+V.scores[1-myTeam]+'</span></div>';
  const action=V.phase==='gameover'
    ? (V.isHost?'<button class="btn solid" id="again">New game</button>':'<span class="waiting">Waiting for the host…</span>')
    : '<button class="btn solid" id="next">Shuffle &amp; deal · '+nameOf((V.dealer+1)%4)+' deals</button>';
  paint('result','<div class="panel"><h3>'+(V.phase==='gameover'?'Game over':'Hand '+V.handNo)+'</h3>'+
    '<p class="verdict">'+verdict+'</p><div class="result">'+rows+'</div><div class="row">'+action+'</div></div>');
  const n=el('next'); if(n) n.onclick=()=>{ closeOv(); send({type:'next'}); };
  const a=el('again'); if(a) a.onclick=()=>{ closeOv(); send({type:'newgame'}); };
}

/* ---------------- chrome ---------------- */
el('btnInvite').onclick=copyInvite;
el('btnRules').onclick=()=>{
  paint('rules','<div class="panel" style="max-width:580px"><h3>How this table plays</h3>'+
  '<div class="scrollbody rulesbox">'+
  '<h4>Six units, not twenty-five</h4><ul>'+
  '<li>Each hand is worth <b>6 units</b>: one per trick, plus one for the <b>highest trump</b> played.</li>'+
  '<li><code>15 = 3 of 6</code>, <code>20 = 4</code>, <code>25 = 5</code>, <code>30 = all 6</code>.</li>'+
  '<li>Make it and you score the units you took; all six pays <b>9</b>. Miss it and you drop the bid’s quota.</li>'+
  '<li>The other side banks the units they won either way. First to the target wins.</li></ul>'+
  '<h4>The auction</h4><ul>'+
  '<li>Five cards each, three then two, from the dealer’s left.</li>'+
  '<li>One round. Raise or pass — <b>only the dealer can take it at the standing number</b>. A 30 ends it on the spot.</li>'+
  '<li>Passed all the way round and <b>the dealer is stuck at 15</b>.</li>'+
  '<li>The bidder names trump, then <b>everyone</b> discards and draws back up to five. A <b>30 is played as dealt</b>.</li>'+
  '<li>The bidder leads; after that whoever wins a trick leads the next.</li></ul>'+
  '<h4>Leading the top trumps together</h4><ul>'+
  '<li>On your lead, holding the <b>5 and the jack</b> of trump, you may lay both down at once. Everyone else then plays <b>two</b> cards. With the <b>ace of hearts</b> as well you may lead all three, and everyone plays <b>three</b>.</li>'+
  '<li>It scores as that many tricks and they all go to you — nothing outranks the 5, so the high trump is yours too.</li>'+
  '<li>Following it, you must put in <b>as many trumps as you hold</b>, up to the number led — but never your best ones, any trumps will do. Two trumps and both go in; one trump and it goes in plus any other card; none and any cards will do.</li>'+
  '<li>Only legal with enough tricks left to cover it, and always your choice.</li></ul>'+
  '<h4>Rank of cards</h4><ul>'+
  '<li><b>Trump, black:</b> 5, J, A♥, A, K, Q, 2, 3, 4, 6, 7, 8, 9, 10</li>'+
  '<li><b>Trump, hearts:</b> 5, J, A, K, Q, 10 … 2</li>'+
  '<li><b>Trump, diamonds:</b> 5, J, A♥, A, K, Q, 10 … 2</li>'+
  '<li><b>Plain, black:</b> K, Q, J, A, 2, 3 … 10</li>'+
  '<li><b>Plain, diamonds:</b> K, Q, J, 10 … 2, A</li>'+
  '<li><b>Plain, hearts:</b> K, Q, J, 10 … 2</li>'+
  '<li>Low in black, high in red.</li></ul>'+
  '<h4>Following</h4><ul>'+
  '<li><b>Plain suit led:</b> follow it or trump it — you can’t throw off a third suit while holding the suit led.</li>'+
  '<li><b>Trump led:</b> you must follow, except the <b>5, jack and ace of hearts</b> may be held back when they are your only trumps <b>and</b> they outrank the card led — lead the 5 and a lone jack or ace of hearts has to fall.</li>'+
  '<li>Trump beats any plain card; otherwise the highest card of the suit led takes it.</li></ul>'+
  '</div><div class="row" style="margin-top:16px"><button class="btn quiet" id="closeR">Close</button></div></div>');
  el('closeR').onclick=closeOv;
};
el('btnSettings').onclick=()=>{
  const s=V.settings;
  paint('settings','<div class="panel"><h3>House rules</h3>'+
  '<p class="dek">Host only. Changes apply from the next hand.</p>'+
  '<div class="setting"><span class="k">Play to</span><input type="number" id="sTarget" min="6" max="200" value="'+s.target+'"></div>'+
  '<div class="setting"><span class="k">Defenders bank their units</span><select id="sDef"><option value="1"'+(s.defendersScore?' selected':'')+'>Yes</option><option value="0"'+(!s.defendersScore?' selected':'')+'>No</option></select></div>'+
  '<div class="setting"><span class="k">Discard &amp; draw</span><select id="sDraw"><option value="everyone"'+(s.draw==='everyone'?' selected':'')+'>Everyone</option><option value="bidder"'+(s.draw==='bidder'?' selected':'')+'>Bidder only</option><option value="none"'+(s.draw==='none'?' selected':'')+'>Nobody</option></select></div>'+
  '<div class="setting"><span class="k">Enforce reneging</span><select id="sRen"><option value="1"'+(s.enforceRenege?' selected':'')+'>Yes</option><option value="0"'+(!s.enforceRenege?' selected':'')+'>No</option></select></div>'+
  '<div class="setting"><span class="k">Dealer may hold</span><select id="sHold"><option value="1"'+(s.dealerHold?' selected':'')+'>Yes</option><option value="0"'+(!s.dealerHold?' selected':'')+'>No</option></select></div>'+
  '<div class="row" style="margin-top:16px"><button class="btn solid" id="saveS">Save</button><button class="btn quiet" id="closeS">Cancel</button></div></div>');
  el('saveS').onclick=()=>{
    send({type:'settings', settings:{
      target:Math.max(6,Math.min(200,+el('sTarget').value||31)),
      defendersScore:el('sDef').value==='1',
      draw:el('sDraw').value,
      enforceRenege:el('sRen').value==='1',
      dealerHold:el('sHold').value==='1'
    }});
    closeOv();
  };
  el('closeS').onclick=closeOv;
};

connect(()=>{
  const code=roomFromUrl();
  const returning = code && store.token && store.lastCode===code;
  if(returning) rejoin(); else renderLobby(true);
});
renderLobby(true);
