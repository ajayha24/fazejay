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
let profiles={}, roster=[];          // everyone's emoji, and who can play
let pickName=null, pickEmoji=null;   // lobby selections before joining
let makingProfile=false, newProfName='';
let locked=[];                       // profiles that have a password set
let pendingPw='';                    // kept only until the join succeeds
let chatSeen=0;                      // newest chat id already shown
let stats={};                        // lifetime record, by name

const EMOJI=['🍀','🔥','🐺','🦊','🐸','🦅','🐢','🦈','🐝','🌙','⭐️','⚡️','🌊','🍺',
             '☕️','🍕','🌮','🎸','🎲','🏒','⚽️','🎯','🧊','👑','💀','🤠','🐙','🌵'];
const DEALER_PORTRAIT='/tim.jpg';    // the house dealer

const store={
  get token(){ try{ return localStorage.getItem('f45.token'); }catch{ return null; } },
  set token(v){ try{ localStorage.setItem('f45.token', v); }catch{} },
  get name(){ try{ return localStorage.getItem('f45.name')||''; }catch{ return ''; } },
  set name(v){ try{ localStorage.setItem('f45.name', v); }catch{} },
  get emoji(){ try{ return localStorage.getItem('f45.emoji')||''; }catch{ return ''; } },
  set emoji(v){ try{ localStorage.setItem('f45.emoji', v); }catch{} },
  get lastCode(){ try{ return localStorage.getItem('f45.lastCode')||''; }catch{ return ''; } },
  set lastCode(v){ try{ localStorage.setItem('f45.lastCode', v); }catch{} }
};

const DECKS=[
  {id:'kitchen', name:'Kitchen',  face:'linear-gradient(170deg,#fbf8f0,#f4efe3 55%,#ddd3bd)', ink:'#b23b2c',
   edge:'rgba(26,21,17,.3)', font:'"Libre Baskerville",Georgia,serif',
   back:'repeating-linear-gradient(45deg,rgba(0,0,0,.22) 0 3px,transparent 3px 6px),linear-gradient(160deg,#5d2a28,#3c1b1a)',
   backEdge:'rgba(244,239,227,.22)'},
  {id:'bicycle', name:'Bicycle',  face:'linear-gradient(180deg,#fff,#f7f7f5)', ink:'#cc1f1f',
   edge:'rgba(0,0,0,.28)', font:'"Archivo",Helvetica,Arial,sans-serif',
   back:'radial-gradient(circle at 50% 50%,rgba(255,255,255,.18) 0 2px,transparent 2px),repeating-linear-gradient(0deg,rgba(255,255,255,.10) 0 2px,transparent 2px 7px),linear-gradient(145deg,#c0392b,#8e2420)',
   backEdge:'rgba(255,255,255,.55)', backSize:'9px 9px,auto,auto'},
  {id:'midnight',name:'Midnight', face:'linear-gradient(170deg,#243b45,#16252c 60%,#101b21)', ink:'#ff7a6b',
   edge:'rgba(255,255,255,.22)', font:'"Archivo",Helvetica,Arial,sans-serif',
   back:'repeating-linear-gradient(135deg,rgba(255,255,255,.07) 0 6px,transparent 6px 12px),linear-gradient(150deg,#1d3b4a,#0d1a21)',
   backEdge:'rgba(170,200,214,.35)'},
  {id:'linen',   name:'Linen',    face:'linear-gradient(170deg,#fdfaf2,#f2ead6)', ink:'#a8442f',
   edge:'rgba(46,42,33,.25)', font:'"Fraunces",Georgia,serif',
   back:'repeating-linear-gradient(0deg,rgba(80,66,46,.16) 0 1px,transparent 1px 5px),repeating-linear-gradient(90deg,rgba(80,66,46,.16) 0 1px,transparent 1px 5px),linear-gradient(160deg,#9a8a63,#6f6245)',
   backEdge:'rgba(253,250,242,.4)'},
  {id:'neon',    name:'Neon',     face:'linear-gradient(170deg,#15151f,#0c0c14)', ink:'#ff4d8d',
   edge:'rgba(94,242,196,.45)', font:'"Archivo",Helvetica,Arial,sans-serif',
   back:'repeating-linear-gradient(45deg,rgba(94,242,196,.16) 0 4px,transparent 4px 10px),linear-gradient(150deg,#241546,#12091f)',
   backEdge:'rgba(94,242,196,.5)'}
];
function applyDeck(id){
  if(!DECKS.some(d=>d.id===id)) id='kitchen';
  document.documentElement.setAttribute('data-deck', id);
  try{ localStorage.setItem('f45.deck', id); }catch{}
}
const currentDeck=()=>{ try{ return localStorage.getItem('f45.deck')||'kitchen'; }catch{ return 'kitchen'; } };

function deckPicker(){
  return '<div class="deckrow">'+DECKS.map(d=>
    '<button class="deckopt" data-deck="'+d.id+'" aria-pressed="'+(d.id===currentDeck())+'" '+
    'style="--sw-face:'+d.face+';--sw-red:'+d.ink+';--sw-edge:'+d.edge+';--sw-font:'+d.font+
    ';--sw-back:'+d.back+';--sw-backedge:'+d.backEdge+(d.backSize?';--sw-backsize:'+d.backSize:'')+'">'+
    '<span class="deckswatch"><i class="f">A</i><i class="b"></i></span>'+
    '<span class="nm">'+d.name+'</span></button>').join('')+'</div>';
}
function wireDeckPicker(root){
  (root||document).querySelectorAll('.deckopt').forEach(b=>b.onclick=()=>{
    applyDeck(b.dataset.deck);
    (root||document).querySelectorAll('.deckopt').forEach(x=>
      x.setAttribute('aria-pressed', String(x.dataset.deck===currentDeck())));
  });
}

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
      if(dealing()){ clearTimeout(window.__settle); window.__settle=setTimeout(render, 8*DEAL_STEP+DEAL_FLIGHT+200); }
    }
    else if(m.type==='joined'){
      myToken=m.token; store.token=m.token; store.lastCode=m.code;
      history.replaceState({}, '', '/t/'+m.code);
    }
    else if(m.type==='profilemade'){
      pickName=m.name; makingProfile=false; newProfName='';
      store.name=m.name; if(pickEmoji) store.emoji=pickEmoji;
      if(ovKind==='lobby') paintLobby();
    }
    else if(m.type==='error'){
      if(ovKind==='lobby') flashPick(m.message); else showError(m.message);
    }
    else if(m.type==='review') showReview(m);
    else if(m.type==='stats'){ stats=m.map||{}; if(ovKind==='stats') paintStats(); }
    else if(m.type==='profiles'){
      profiles=m.map||{}; roster=m.roster||[]; locked=m.locked||[];
      if(V) render();
      if(ovKind==='lobby') paintLobby();      // the picker needs the roster
    }
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
const DEAL_STEP=130;                     // ms between packets
const DEAL_FLIGHT=300;                   // ms a card spends in the air

function dealDelays(){
  const pat=(V && V.dealPattern) || [3,2];
  const seatOrder=[0,1,2,3].map(k=>(V.dealer+1+k)%4);
  const packet=[];                       // one entry per packet, in dealing order
  for(const chunk of pat) for(const seat of seatOrder) packet.push({seat, chunk});
  const perSeat={};
  packet.forEach((p,i)=>{
    (perSeat[p.seat]=perSeat[p.seat]||[]).push({at:i*DEAL_STEP, n:p.chunk});
  });
  return perSeat;
}

/* Cards come off the deck in front of the dealer, so that is where they fly
   from. Offsets are relative to each seat's own resting place. */
function dealOrigin(seat){
  const from=screenPos(V.dealer), to=screenPos(seat);
  const at=p=>[[0,300],[-330,0],[0,-300],[330,0]][p];   // s, w, n, e
  const a=at(from), b=at(to);
  return [a[0]-b[0], a[1]-b[1]];
}

/* Where in the sequence a given card arrives, and how far it has to travel. */
function dealStyle(anim, idx, seat, spread){
  let acc=0, at=0;
  for(const p of anim){ if(idx<acc+p.n){ at=p.at; break; } acc+=p.n; }
  const [dx,dy]=dealOrigin(seat);
  const tilt=(idx-spread)*3;
  return ' style="animation-delay:'+at+'ms;--dx:'+dx+'px;--dy:'+dy+'px;--dr:'+tilt+'deg"';
}
const dealing=()=>V && V.handNo && (Date.now()-dealAt) < 8*DEAL_STEP+DEAL_FLIGHT+120;

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
  let spec=el('specnote');
  const names=(V.spectators||[]);
  if(names.length||V.spectating){
    if(!spec){ spec=document.createElement('div'); spec.id='specnote'; spec.className='specnote';
      document.querySelector('.board').appendChild(spec); }
    spec.innerHTML=(V.spectating?'<b>You are spectating</b> — every hand is face up. ':'')+
      (names.length? names.map(esc).join(', ')+(names.length>1?' are':' is')+' spectating.' : '');
    spec.hidden=false;
  } else if(spec) spec.hidden=true;
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
  renderChat();
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
               ||(V.phase==='drawing'&&V.drawers&&V.drawers.includes(seat)&&!V.ready[seat]);
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
      '<span class="avatar">'+avatarHTML(nameOf(seat))+'</span>'+
      '<span class="pname">'+(seat===V.mySeat?'You':nameOf(seat))+'</span>'+
      (roles.length?'<span class="prole">'+roles.join(' · ')+'</span>':'')+chip+'</div>';

    if(pos===0){ box.innerHTML=plate; continue; }
    const vert=(pos===1||pos===3);
    const backSig=[V.handNo, V.counts[seat]||0, vert,
      V.allHands?(V.allHands[seat]||[]).map(c=>c.id).join(''):''].join('|');
    const existing=box.querySelector('.backs');
    if(existing && existing.dataset.sig===backSig){
      // leave the backs alone — only the plate above or below them changes
      const plateEl=box.querySelector('.plate');
      if(plateEl) plateEl.outerHTML=plate;
      continue;
    }
    const an=dealing()&&V.phase==='bidding'?dealDelays()[seat]:null;
    const open=V.allHands && V.allHands[seat];
    const backs=open
      ? '<div class="backs open" data-sig="'+backSig+'-open">'+
        open.map(c=>cardHTML(c,{small:true,trump:V.trump&&isTrumpC(c)})).join('')+'</div>'
      : '<div class="backs'+(vert?' vert':'')+'" data-sig="'+backSig+'">'+
        Array.from({length:V.counts[seat]||0},(_,idx)=>
          an ? '<span class="back dealt"'+dealStyle(an, idx, seat, 2)+'></span>'
             : '<span class="back"></span>').join('')+'</div>';
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
    wi.innerHTML='<span class="lbl">Shuffling</span>'+
      '<div class="dealerbox"><img class="dealerpic" src="'+DEALER_PORTRAIT+'" alt="the dealer">'+
      '<div class="shuffle"><span class="back"></span><span class="back"></span>'+
      '<span class="back"></span><span class="back"></span></div></div>'+
      '<span class="trumpname">'+nameOf(V.dealer)+' deals</span>';
  }else if(V.trump){
    wi.innerHTML='<span class="lbl">Trump</span>'+
      '<span class="trumpmark'+(RED[V.trump]?' red':'')+'">'+GLYPH[V.trump]+'</span>'+
      '<span class="trumpname">'+SUITNAME[V.trump]+'</span>'+
      '<span class="lbl">Trick '+Math.min(V.trickNo+1,5)+' of 5</span>';
  }else if(V.phase==='bidding'){
    wi.innerHTML='<span class="lbl">Auction</span><span class="trumpname">'+
      (V.highBid?nameOf(V.highBid.seat)+' at '+V.highBid.value:'no bid yet')+'</span>'+
      (V.kitty? '<div class="kitty">'+Array.from({length:V.kitty},()=>'<span class="back"></span>').join('')+
                '</div><span class="lbl">kitty · '+V.kitty+'</span>' : '');
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

/* Would this card be winning the trick if played right now? With everyone else
   already in, that is final; otherwise it only holds against what is down. */
function wouldTake(card){
  if(!V.trump || !V.trick) return false;
  if(!V.trick.length) return false;                 // nothing to beat yet
  const probe=V.trick.concat([{seat:V.mySeat, card}]);
  return localWinner(probe).seat===V.mySeat;
}
const takeIsFinal=()=>V.trick && V.trick.length===3;

function renderHand(){
  // Rebuilding the DOM restarts every running animation, so bail out when
  // nothing about the hand has changed. This is what made the deal stutter.
  const h0=el('hand');
  const sig=[V.mySeat, V.handNo, (V.hand||[]).map(c=>c.id).join(','),
             (V.legal||[]).join(','), [...discardSel].join(','),
             (V.trick||[]).map(x=>x.card.id).join(','),
             V.phase, V.iAmReady, !!(V.mustPlay)].join('|');
  if(h0.dataset.sig===sig) return;
  h0.dataset.sig=sig;
  const h=el('hand');
  if(V.mySeat===null){
    const mine=V.allHands && V.allHands[0];
    h.innerHTML=mine? mine.map(c=>cardHTML(c,{trump:V.trump&&isTrumpC(c)})).join('') : '';
    return;
  }
  if(!V.hand){ h.innerHTML=''; return; }
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
    const wins=!discarding&&!contributing&&V.legal&&V.legal.includes(c.id)&&wouldTake(c);
    if(wins) cls+=' takes';
    let style='';
    if(anim){ cls+=' dealt'; style=dealStyle(anim, idx, V.mySeat, 2); }
    let html=cardHTML(c,{trump:V.trump&&isTrumpC(c),cls})
      .replace('<span class="card','<button type="button" data-id="'+c.id+'"'+(disabled?' disabled':'')+style+' class="card')
      .replace(/<\/span>$/,'</button>');
    if(wins) html=html.replace('</button>','<span class="wins">'+(takeIsFinal()?'takes it':'winning')+'</span></button>');
    return html;
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
    const canHold=V.holdAllowed&&me===V.dealer&&V.highBid&&cur<30;
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
  else if(V.phase==='drawing'&&V.drawers&&V.drawers.includes(me)&&!V.iAmReady){
    const n=discardSel.size, over=(V.hand.length-n)-5;
    cue='<span class="cue">'+(over>0
        ? 'Throw <b>'+over+'</b> more to come down to five'
        : 'Click cards to throw away')+'</span>';
    btns='<button class="btn solid" data-act="draw"'+(over>0?' disabled':'')+'>'+
         (n?'Lock in — throw '+n:'Stand pat')+'</button>'+
         (n?'<button class="btn quiet" data-act="clear">Clear</button>':'');
    msg=V.hand.length>5
      ? 'You took the kitty — <strong>'+V.hand.length+' cards</strong>. Keep your best five.'
      : '<strong>'+SUITNAME[V.trump]+' '+GLYPH[V.trump]+'</strong> is trump — keep what helps. Everyone picks at once.';
  }
  else if(V.phase==='drawing'){
    msg=V.waitingCount
      ? 'Locked in — waiting on <strong>'+V.waitingCount+'</strong> more.'
      : 'Dealing from the dealer’s left…';
  }
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
      (host
        ? '<h4 style="margin:16px 0 0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600">Kitty</h4>'+
          '<div class="deckrow" id="kittyRow">'+
          [[0,'Off'],[3,'On']].map(k=>
            '<button class="deckopt" data-kitty="'+k[0]+'" aria-pressed="'+(Number(V.settings.kitty||0)===k[0])+'">'+
            '<span class="nm">'+k[1]+'</span></button>').join('')+'</div>'+
          '<p class="dek" style="margin:6px 0 0;font-size:12px">Three cards face down for whoever buys the hand. With a kitty in play the dealer cannot hold the bid.</p>'
        : '<p class="dek" style="margin:14px 0 0;font-size:12.5px">Kitty: <b>'+
          (V.settings.kitty? 'on':'off')+'</b></p>')+
      '<h4 style="margin:16px 0 0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600">Your deck</h4>'+
      deckPicker()+
      (myTeam?'<p class="waiting" style="margin:10px 0 0">You’re on <b style="color:var(--sage)">'+myTeam+'</b></p>':'')+
      '<div class="row" style="margin-top:14px">'+
      (host?'<button class="btn solid" id="startBtn">Deal the first hand</button>'
           :'<span class="waiting">Waiting for the host to deal…</span>')+'</div></div>';
  } else {
    body='<div class="panel"><h3>Kitchen Table 45s</h3>'+
      '<p class="dek">Four players, two teams, six units a hand. Start a table and send the link to three friends — empty seats are covered by bots.</p>'+
      '<h4 class="pickhead">Who are you?</h4>'+
      (roster.length
        ? '<div class="namegrid">'+roster.map(n=>
            '<button class="nameopt" data-name="'+esc(n)+'" aria-pressed="'+(n===pickName)+'">'+
            '<span class="em">'+avatarHTML(n)+'</span><span class="nm">'+esc(n)+'</span></button>').join('')+'</div>'
        : '<p class="dek" style="margin:8px 0 0">No profiles yet — make the first one.</p>')+
      '<div class="row" style="margin-top:9px">'+
        '<button class="btn quiet tiny" id="newProfBtn">'+(makingProfile?'Cancel':'+ New profile')+'</button>'+
      '</div>'+
      (makingProfile
        ? '<div class="lobby" style="margin-top:10px">'+
            '<label>Profile name<input id="profName" maxlength="14" placeholder="Your name" value="'+esc(newProfName)+'"></label>'+
          '</div>'+
          '<h4 class="pickhead">Pick an emoji, or use a photo</h4>'+
          '<div class="emgrid">'+EMOJI.map(e=>
            '<button class="emopt" data-emoji="'+e+'" aria-pressed="'+(e===pickEmoji)+'">'+e+'</button>').join('')+'</div>'+
          '<div class="row" style="margin-top:9px">'+
            '<button class="btn quiet tiny" id="photoBtn">'+(isPhoto(pickEmoji)?'Change photo':'Use a photo')+'</button>'+
            (isPhoto(pickEmoji)?'<img class="pfp lg" src="'+pickEmoji+'" alt="your picture">':'')+'</div>'+
          '<div class="lobby" style="margin-top:10px">'+
            '<label>Password<input id="profPw" type="password" maxlength="40" placeholder="At least 4 characters"></label>'+
          '</div>'+
          '<div class="row" style="margin-top:12px"><button class="btn solid" id="makeProfBtn">Create profile</button></div>'
        : (pickName
            ? '<h4 class="pickhead">Your emoji, or a photo</h4>'+
              '<div class="emgrid">'+EMOJI.map(e=>
                '<button class="emopt" data-emoji="'+e+'" aria-pressed="'+(e===pickEmoji)+'">'+e+'</button>').join('')+'</div>'+
              '<div class="row" style="margin-top:9px">'+
                '<button class="btn quiet tiny" id="photoBtn">'+(isPhoto(profiles[pickName])?'Change photo':'Use a photo')+'</button>'+
                (isPhoto(profiles[pickName])?'<img class="pfp lg" src="'+profiles[pickName]+'" alt="your picture">':'')+'</div>'
            : ''))+
      (pickName&&!makingProfile
        ? '<div class="lobby" style="margin-top:12px">'+
            '<label>Password<input id="joinPw" type="password" maxlength="40" placeholder="'+
            (locked.includes(pickName)?'Your password':'Set a password for this profile')+'"></label></div>'
        : '')+
      (code?'<div class="lobby" style="margin-top:12px">'+
        '<label>Table code<input id="code" value="'+code+'" maxlength="4"></label></div>':'')+
      '<h4 class="pickhead">Your deck</h4>'+
      deckPicker()+
      '<div class="row" style="margin-top:16px">'+
      (code?'<button class="btn solid" id="joinBtn">Join table</button>':'')+
      '<button class="btn'+(code?' quiet':' solid')+'" id="newBtn">Start a new table</button>'+
      '</div></div>';
  }
  paint('lobby', body);

  wireDeckPicker(ov);
  // who you are, and your emoji
  if(!pickName && store.name && (!roster.length || roster.includes(store.name))) pickName=store.name;
  if(!pickEmoji && store.emoji) pickEmoji=store.emoji;
  ov.querySelectorAll('[data-name]').forEach(b=>b.onclick=()=>{
    pickName=b.dataset.name; makingProfile=false;
    pickEmoji=profiles[pickName]||pickEmoji;
    paintLobby();
  });
  ov.querySelectorAll('[data-emoji]').forEach(b=>b.onclick=()=>{
    pickEmoji=b.dataset.emoji;
    if(!makingProfile && pickName){
      const f=el('joinPw'), pw=f?f.value:'';
      if(pw){ send({type:'signin', name:pickName, password:pw});
              setTimeout(()=>send({type:'profile', name:pickName, avatar:pickEmoji}), 120); }
    }
    paintLobby();
  });
  const np=el('newProfBtn');
  if(np) np.onclick=()=>{ makingProfile=!makingProfile; if(makingProfile){ pickName=null; } paintLobby();
    const f=el('profName'); if(f) f.focus(); };
  const mk=el('makeProfBtn');
  if(mk) mk.onclick=()=>{
    const nm=(el('profName').value||'').trim();
    if(!nm) return flashPick('Type a name for the profile.');
    if(!pickEmoji) return flashPick('Pick an emoji or a photo too.');
    const pw=(el('profPw').value||'');
    if(pw.length<4) return flashPick('Give it a password of at least 4 characters.');
    newProfName=nm; pendingPw=pw;
    send({type:'newprofile', name:nm, avatar:pickEmoji, password:pw});
  };
  const pf=el('profName');
  if(pf) pf.oninput=()=>{ newProfName=pf.value; };
  const ph=el('photoBtn');
  if(ph) ph.onclick=()=>openCropper(data=>{
    pickEmoji=data;
    if(!makingProfile && pickName){
      const f=el('joinPw'), pw=f?f.value:'';
      if(pw) send({type:'signin', name:pickName, password:pw});
      setTimeout(()=>send({type:'profile', name:pickName, avatar:data}), 120);
      store.emoji=data;
    }
    paintLobby();
  });
  ov.querySelectorAll('[data-kitty]').forEach(b=>b.onclick=()=>
    send({type:'settings', settings:{kitty:Number(b.dataset.kitty)}}));
  const cp=el('copyLink'); if(cp) cp.onclick=copyInvite;
  const sb=el('startBtn'); if(sb) sb.onclick=()=>send({type:'start'});
  ov.querySelectorAll('[data-sit]').forEach(b=>b.onclick=()=>send({type:'sit', seat:+b.dataset.sit}));
  const identify=()=>{
    if(!pickName){ flashPick('Pick a profile first, or make one.'); return false; }
    const f=el('joinPw');
    const pw=f ? f.value : (pendingPw||'');
    if(!pw){ flashPick(locked.includes(pickName)?'Enter the password for '+pickName+'.'
                                                :'Set a password for '+pickName+'.'); return false; }
    if(!locked.includes(pickName) && pw.length<4){ flashPick('Use at least 4 characters.'); return false; }
    store.name=pickName; pendingPw=pw;
    return true;
  };
  const jb=el('joinBtn');
  if(jb) jb.onclick=()=>{ if(!identify()) return;
    send({type:'join', code:el('code').value.trim().toUpperCase(), token:store.token,
          name:store.name, password:pendingPw}); };
  const nb=el('newBtn');
  if(nb) nb.onclick=()=>{ if(!identify()) return;
    send({type:'create', name:store.name, password:pendingPw}); };
}

function flashPick(msg){
  let n=ov.querySelector('.picknote');
  if(!n){ n=document.createElement('p'); n.className='picknote';
    const row=ov.querySelector('.panel .row'); if(row) row.parentNode.insertBefore(n,row); }
  n.textContent=msg;
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
    ? (V.isHost?'<button class="btn solid" id="again">New game</button>':'<span class="waiting">Waiting for the host…</span>')+
      '<button class="btn quiet" id="statsBtn">Lifetime record</button>'
    : '<button class="btn solid" id="next">Shuffle &amp; deal · '+nameOf((V.dealer+1)%4)+' deals</button>';
  const canReview = V.mySeat!==null;
  paint('result','<div class="panel"><h3>'+(V.phase==='gameover'?'Game over':'Hand '+V.handNo)+'</h3>'+
    '<p class="verdict">'+verdict+'</p><div class="result">'+rows+'</div>'+
    (canReview?'<div class="review" id="reviewBox"><button class="btn quiet" id="reviewBtn">How did I play?</button></div>':'')+
    '<div class="row">'+action+'</div></div>');
  const rb=el('reviewBtn'); if(rb) rb.onclick=requestReview;
  const sb=el('statsBtn'); if(sb) sb.onclick=()=>{ send({type:'stats'}); paintStats(); };
  const n=el('next'); if(n) n.onclick=()=>{ closeOv(); send({type:'next'}); };
  const a=el('again'); if(a) a.onclick=()=>{ closeOv(); send({type:'newgame'}); };
}

/* ---------------- table chat ----------------
   Bubbles sit over empty cloth on the left of the table, clear of your hand,
   the action bar and the trick well. */
function chatUI(){
  let box=el('chatbox');
  if(box) return box;
  box=document.createElement('div');
  box.id='chatbox'; box.className='chatbox';
  box.innerHTML='<div class="bubbles" id="bubbles"></div>'+
    '<form class="chatform" id="chatform" autocomplete="off">'+
      '<input id="chatin" maxlength="160" placeholder="Say something…" aria-label="Table chat">'+
      '<button class="btn tiny" type="submit">Send</button></form>';
  document.querySelector('.board').appendChild(box);
  el('chatform').onsubmit=e=>{
    e.preventDefault();
    const i=el('chatin'), t=i.value.trim();
    if(t){ send({type:'chat', text:t}); i.value=''; }
  };
  return box;
}
function renderChat(){
  if(V.mySeat===null && !(V.chat||[]).length) return;
  chatUI();
  const list=V.chat||[];
  const wrap=el('bubbles');
  const sig=list.map(c=>c.id).join(',');
  if(wrap.dataset.sig===sig) return;
  wrap.dataset.sig=sig;
  const now=Date.now();
  wrap.innerHTML=list.slice(-5).map(c=>{
    const mine=c.seat===V.mySeat;
    const fresh=now-c.at<9000;
    return '<div class="bubble'+(mine?' mine':'')+(fresh?' fresh':'')+'">'+
      '<span class="who">'+avatarHTML(c.name,'sm')+' '+esc(c.name)+'</span>'+
      '<span class="said">'+esc(c.text)+'</span></div>';
  }).join('');
  wrap.scrollTop=wrap.scrollHeight;
}
const esc=t=>String(t).replace(/[&<>"']/g,ch=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

/* ---------------- the walkthrough ----------------
   A scripted hand that plays itself, so the rules can be watched rather than
   read. Drawn with the same cards as the game, so nothing has to be loaded. */
const DEMO_SEATS=['You','Izak','Tim','Kate'];
const demoCard=id=>({r:id.slice(0,-1), s:id.slice(-1), id});
const DEMO=[
  {t:'Five cards each, three then two.',
   hand:['5S','KS','9S','QH','7D'], note:'This is your hand. Spades look strong — five of them is the best trump there is.'},
  {t:'The auction goes round once.',
   hand:['5S','KS','9S','QH','7D'],
   bids:[null,'pass',15,'pass'],
   note:'Each player passes or bids higher. 15 means taking 3 of the 6 units, 20 means 4, 25 means 5, 30 means all six.'},
  {t:'You hold the 5 — that is always worth a bid.',
   hand:['5S','KS','9S','QH','7D'], bids:[20,'pass',15,'pass'],
   note:'The 5 of trump is the highest card in the game. With the king behind it, 20 is right here.'},
  {t:'You bought it, so you name trump.',
   hand:['5S','KS','9S','QH','7D'], bids:[20,'pass',15,'pass'], trump:'S',
   note:'Spades. Now the ace of hearts joins them — it is the third-best trump whatever gets called.'},
  {t:'Everyone throws what is not trump.',
   hand:['5S','KS','9S'], bids:[20,'pass',15,'pass'], trump:'S', kept:3,
   note:'You keep three spades and draw two fresh cards. How many each player keeps tells you their trump count.'},
  {t:'Back up to five.',
   hand:['5S','KS','9S','AH','3C'], trump:'S', kept:3,
   note:'The ace of hearts came back — now you hold three of the top five trumps.'},
  {t:'The bidder leads.', hand:['5S','KS','9S','AH','3C'], trump:'S',
   trick:[['3C',0]], note:'A low plain card first. Leading the 5 straight away buries your partner\'s good cards.'},
  {t:'Follow the suit led, or trump it.', hand:['5S','KS','9S','AH'], trump:'S',
   trick:[['3C',0],['KC',1],['9S',2]], note:'Izak plays a club. Tim has none, so he trumps with the 9 of spades and is winning.'},
  {t:'That trick is yours.', hand:['5S','KS','AH'], trump:'S',
   trick:[['3C',0],['KC',1],['9S',2],['AH',3]], won:true,
   note:'Your partner comes over the top with the ace of hearts. Trump beats any plain card, and the higher trump wins.'},
  {t:'Six units, not five.', trump:'S', units:true,
   note:'One for each of the five tricks, and one more for whoever played the highest trump all hand. You bid 20, so you need 4 of those 6.'}
];
let demoStep=0, demoTimer=null;

function paintDemo(){
  const d=DEMO[demoStep];
  const card=(id,cls)=>cardHTML(demoCard(id),{small:true,trump:d.trump&&(id.slice(-1)===d.trump||id==='AH'),cls});
  let stage='';
  if(d.trick){
    stage='<div class="demotrick">'+d.trick.map(([id,seat])=>
      '<div class="dt"><span class="who">'+DEMO_SEATS[seat]+'</span>'+card(id)+'</div>').join('')+'</div>';
  } else if(d.bids){
    stage='<div class="demobids">'+d.bids.map((b,i)=>
      '<div class="db'+(b&&b!=='pass'?' in':'')+'"><span class="who">'+DEMO_SEATS[i]+'</span>'+
      '<span class="bv">'+(b===null?'—':b==='pass'?'pass':b)+'</span></div>').join('')+'</div>';
  } else if(d.units){
    stage='<div class="demounits">'+[1,2,3,4,5].map(n=>'<span class="u">'+n+'</span>').join('')+
          '<span class="u hi">high</span></div>';
  }
  const hand=d.hand? '<div class="demohand">'+d.hand.map(id=>card(id)).join('')+'</div>' : '';
  const trumpTag=d.trump? '<span class="demotrump">trump '+GLYPH[d.trump]+'</span>' : '';

  paint('demo','<div class="panel" style="max-width:520px"><h3>How a hand goes</h3>'+
    '<div class="demostage">'+stage+hand+'</div>'+
    '<p class="demotitle">'+d.t+' '+trumpTag+'</p>'+
    '<p class="demonote">'+d.note+'</p>'+
    '<div class="demobar"><div class="demodots">'+DEMO.map((_,i)=>
      '<span class="dot'+(i===demoStep?' on':'')+'"></span>').join('')+'</div></div>'+
    '<div class="row" style="margin-top:12px">'+
      '<button class="btn quiet" id="demoPrev"'+(demoStep?'':' disabled')+'>Back</button>'+
      '<button class="btn solid" id="demoNext">'+(demoStep===DEMO.length-1?'Start again':'Next')+'</button>'+
      '<button class="btn quiet" id="demoPlay">'+(demoTimer?'Pause':'Play it through')+'</button>'+
      '<button class="btn quiet" id="demoClose">Close</button>'+
    '</div></div>');
  el('demoPrev').onclick=()=>{ stopDemo(); if(demoStep) demoStep--; paintDemo(); };
  el('demoNext').onclick=()=>{ stopDemo(); demoStep=(demoStep+1)%DEMO.length; paintDemo(); };
  el('demoPlay').onclick=()=>{ demoTimer? stopDemo() : playDemo(); paintDemo(); };
  el('demoClose').onclick=()=>{ stopDemo(); closeOv(); };
}
function playDemo(){
  stopDemo();
  demoTimer=setInterval(()=>{
    if(demoStep===DEMO.length-1){ stopDemo(); paintDemo(); return; }
    demoStep++; paintDemo();
  }, 4200);
}
function stopDemo(){ clearInterval(demoTimer); demoTimer=null; }

/* ---------------- profile photo ----------------
   Pick a picture, pan and zoom it inside a square, and keep a small crop.
   On a phone the file input opens the camera roll; Safari hands back a JPEG
   even when the original is HEIC. */
const isPhoto=v=>typeof v==='string' && v.startsWith('data:image');
function avatarHTML(name, cls){
  const a=profiles[name];
  if(isPhoto(a)) return '<img class="pfp'+(cls?' '+cls:'')+'" src="'+a+'" alt="">';
  return a || (name||'?').slice(0,1).toUpperCase();
}

function openCropper(onDone){
  const V=236;                       // preview size
  let img=null, zoom=1, base=1, ox=0, oy=0, drag=null, pinch=null;

  paint('crop','<div class="panel" style="max-width:380px"><h3>Your picture</h3>'+
    '<p class="dek">Pick a photo, then drag to move it and pinch or use the slider to zoom.</p>'+
    '<div class="cropwrap"><canvas id="cropc" width="'+V+'" height="'+V+'"></canvas>'+
      '<div class="cropmask"></div></div>'+
    '<input type="range" id="cropzoom" min="100" max="400" value="100" class="zoomer" aria-label="Zoom">'+
    '<div class="row" style="margin-top:12px">'+
      '<label class="btn" for="pfile">Choose a photo</label>'+
      '<input type="file" id="pfile" accept="image/*" hidden>'+
      '<button class="btn solid" id="cropSave" disabled>Use this</button>'+
      '<button class="btn quiet" id="cropCancel">Cancel</button>'+
    '</div></div>');

  const cv=el('cropc'), cx=cv.getContext('2d');
  const clamp=()=>{
    const w=img.width*base*zoom, h=img.height*base*zoom;
    ox=Math.min(0, Math.max(V-w, ox));
    oy=Math.min(0, Math.max(V-h, oy));
  };
  const draw=()=>{
    cx.clearRect(0,0,V,V);
    if(!img){ return; }
    cx.imageSmoothingQuality='high';
    cx.drawImage(img, ox, oy, img.width*base*zoom, img.height*base*zoom);
  };
  const fit=()=>{
    base=Math.max(V/img.width, V/img.height);
    zoom=1; ox=(V-img.width*base)/2; oy=(V-img.height*base)/2;
    el('cropzoom').value=100; draw();
  };

  el('pfile').onchange=e=>{
    const f=e.target.files && e.target.files[0];
    if(!f) return;
    const url=URL.createObjectURL(f);
    const im=new Image();
    im.onload=()=>{ img=im; fit(); el('cropSave').disabled=false; URL.revokeObjectURL(url); };
    im.onerror=()=>{ flashCrop('That picture would not open. Try a JPEG or PNG.'); URL.revokeObjectURL(url); };
    im.src=url;
  };
  el('cropzoom').oninput=e=>{
    if(!img) return;
    const z=Number(e.target.value)/100, cxp=V/2, cyp=V/2;
    ox=cxp-(cxp-ox)*(z/zoom); oy=cyp-(cyp-oy)*(z/zoom);
    zoom=z; clamp(); draw();
  };
  const pt=e=>{ const r=cv.getBoundingClientRect(); return {x:e.clientX-r.left, y:e.clientY-r.top}; };
  cv.onpointerdown=e=>{ if(!img) return; cv.setPointerCapture(e.pointerId); drag=pt(e); };
  cv.onpointermove=e=>{ if(!drag||!img) return; const p=pt(e); ox+=p.x-drag.x; oy+=p.y-drag.y; drag=p; clamp(); draw(); };
  cv.onpointerup=()=>{ drag=null; };
  cv.onpointercancel=()=>{ drag=null; };
  cv.onwheel=e=>{
    if(!img) return; e.preventDefault();
    const z=Math.min(4, Math.max(1, zoom*(e.deltaY<0?1.08:0.93)));
    const p=pt(e); ox=p.x-(p.x-ox)*(z/zoom); oy=p.y-(p.y-oy)*(z/zoom);
    zoom=z; el('cropzoom').value=Math.round(z*100); clamp(); draw();
  };

  el('cropCancel').onclick=()=>{ closeOv(); paintLobby(); };
  el('cropSave').onclick=()=>{
    if(!img) return;
    const S=176, out=document.createElement('canvas');
    out.width=S; out.height=S;
    const o=out.getContext('2d');
    o.imageSmoothingQuality='high';
    const k=S/V;
    o.drawImage(img, ox*k, oy*k, img.width*base*zoom*k, img.height*base*zoom*k);
    let data=out.toDataURL('image/jpeg', 0.82);
    if(data.length>150000) data=out.toDataURL('image/jpeg', 0.6);
    closeOv(); onDone(data);
  };
}
function flashCrop(msg){
  const p=ov.querySelector('.panel .dek');
  if(p){ p.textContent=msg; p.style.color='var(--rouge-bright)'; }
}

/* ---------------- lifetime record ---------------- */
let statsMode='pvp';
function paintStats(){
  const bucket=n=>{
    const r=stats[n]||{};
    if(r.games!==undefined) return statsMode==='bots'?r:null;   // older flat record
    return r[statsMode]||null;
  };
  const names=Object.keys(stats).filter(n=>{ const r=bucket(n); return r&&r.hands; });
  names.sort((a,b)=>{
    const A=bucket(a),B=bucket(b);
    const wa=A.games?A.wins/A.games:0, wb=B.games?B.wins/B.games:0;
    return (wb-wa)||(B.books-A.books);
  });
  const rows = names.length ? names.map(n=>{
    const r=bucket(n);
    const pct=r.games?Math.round(100*r.wins/r.games)+'%':'—';
    const bph=r.hands?(r.books/r.hands).toFixed(2):'—';
    const madepct=r.bids?Math.round(100*r.made/r.bids)+'%':'—';
    return '<tr><td class="who">'+avatarHTML(n,'sm')+' '+esc(n)+'</td>'+
      '<td>'+r.wins+'/'+r.games+'</td><td>'+pct+'</td>'+
      '<td>'+r.books+'</td><td>'+bph+'</td>'+
      '<td>'+r.bids+'</td><td>'+madepct+'</td>'+
      '<td class="'+(r.points>=0?'pos':'neg')+'">'+(r.points>0?'+':'')+r.points+'</td></tr>';
  }).join('') : '<tr><td colspan="8" class="none">'+
      (statsMode==='pvp'
        ? 'No hands yet with all four seats filled by people.'
        : 'No hands yet against the computer.')+'</td></tr>';

  paint('stats','<div class="panel" style="max-width:660px"><h3>Lifetime record</h3>'+
    '<div class="deckrow" style="margin:2px 0 12px">'+
      '<button class="deckopt" data-smode="pvp" aria-pressed="'+(statsMode==='pvp')+'"><span class="nm">Against people</span></button>'+
      '<button class="deckopt" data-smode="bots" aria-pressed="'+(statsMode==='bots')+'"><span class="nm">Against the computer</span></button>'+
    '</div>'+
    '<p class="dek">'+(statsMode==='pvp'
      ? 'Only hands where all four seats were human when the first book was played.'
      : 'Hands with at least one seat played by a bot.')+'</p>'+
    '<div class="statswrap"><table class="stats">'+
    '<thead><tr><th>Player</th><th>Won</th><th>Win rate</th><th>Books</th>'+
    '<th>Per hand</th><th>Bids</th><th>Made</th><th>Points</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table></div>'+
    '<div class="row" style="margin-top:16px"><button class="btn quiet" id="closeStats">Close</button></div></div>');
  ov.querySelectorAll('[data-smode]').forEach(b=>b.onclick=()=>{ statsMode=b.dataset.smode; paintStats(); });
  el('closeStats').onclick=closeOv;
}

/* ---------------- post-hand review ---------------- */
let reviewPending=false;
function requestReview(){
  reviewPending=true;
  const b=el('reviewBtn');
  if(b){ b.textContent='Working it out…'; b.disabled=true; }
  send({type:'review'});
}
function showReview(m){
  reviewPending=false;
  const box=el('reviewBox');
  if(!box) return;
  if(m.unavailable){
    box.innerHTML='<p class="dek" style="margin:0">'+
      (m.unavailable==='declaration'
        ? 'No review for a hand with a declaration in it — several cards land at once, so there is no single choice to weigh.'
        : 'Could not work this hand out.')+'</p>';
    return;
  }
  const par=m.par, took=m.took;
  let head;
  if(took===null||took===undefined) head='Best play was worth <b>'+par+'</b> of 6.';
  else if(took>=par) head='You took <b>'+took+'</b> of 6 — the most this deal could give you.';
  else head='You took <b>'+took+'</b> of 6. Best play was worth <b>'+par+'</b>.';

  let body;
  if(!m.notes.length){
    body='<p class="revline good">Every card you played held its value. Nothing to change.</p>';
  }else{
    body=m.notes.map(n=>{
      const better=n.better.map(id=>{
        const c={r:id.slice(0,-1),s:id.slice(-1)};
        return '<b class="'+(RED[c.s]?'cr':'ck')+'">'+c.r+GLYPH[c.s]+'</b>';
      }).join(' or ');
      const played='<b class="'+(RED[n.card.s]?'cr':'ck')+'">'+n.card.r+GLYPH[n.card.s]+'</b>';
      return '<p class="revline"><span class="rt">Trick '+n.trickNo+'</span> '+
        (n.lead?'led ':'played ')+played+' — cost <b>'+n.cost+'</b> unit'+(n.cost>1?'s':'')+
        '. '+better+' would have held.</p>';
    }).join('');
  }
  box.innerHTML='<p class="revhead">'+head+'</p>'+body+
    '<p class="dek" style="margin:10px 0 0;font-size:11.5px">Worked out with every hand face up, so it is the best that was ever available — not what you could have known at the time.</p>';
}

/* ---------------- chrome ---------------- */
el('btnInvite').onclick=copyInvite;
el('btnStats').onclick=()=>{ send({type:'stats'}); paintStats(); };
el('btnDeck').onclick=()=>{
  paint('deck','<div class="panel"><h3>Choose your deck</h3>'+
    '<p class="dek">Just for you — everyone at the table picks their own.</p>'+
    deckPicker()+
    '<div class="row" style="margin-top:18px"><button class="btn quiet" id="closeD">Done</button></div></div>');
  wireDeckPicker(ov);
  el('closeD').onclick=closeOv;
};
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
  '<li><b>Kitty</b> (optional): three cards go face down in the middle. Whoever buys the hand takes them in and then comes back down to five. With a kitty in play the dealer <b>cannot</b> hold the bid.</li>'+
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
  '</div><div class="row" style="margin-top:16px">'+
  '<button class="btn solid" id="watchDemo">Watch a hand</button>'+
  '<button class="btn quiet" id="closeR">Close</button></div></div>');
  el('closeR').onclick=closeOv;
  const wd=el('watchDemo');
  if(wd) wd.onclick=()=>{ demoStep=0; paintDemo(); };
};
el('btnSettings').onclick=()=>{
  const s=V.settings;
  paint('settings','<div class="panel"><h3>House rules</h3>'+
  '<p class="dek">Host only. Changes apply from the next hand.</p>'+
  '<div class="setting"><span class="k">Play to</span><input type="number" id="sTarget" min="6" max="200" value="'+s.target+'"></div>'+
  '<div class="setting"><span class="k">Defenders bank their units</span><select id="sDef"><option value="1"'+(s.defendersScore?' selected':'')+'>Yes</option><option value="0"'+(!s.defendersScore?' selected':'')+'>No</option></select></div>'+
  '<div class="setting"><span class="k">Kitty<small>Three cards face down for whoever buys the hand. The dealer cannot hold the bid.</small></span>'+
    '<select id="sKitty"><option value="0"'+(!s.kitty?' selected':'')+'>Off</option>'+
    '<option value="3"'+(s.kitty?' selected':'')+'>On</option></select></div>'+
  '<div class="setting"><span class="k">Discard &amp; draw</span><select id="sDraw"><option value="everyone"'+(s.draw==='everyone'?' selected':'')+'>Everyone</option><option value="bidder"'+(s.draw==='bidder'?' selected':'')+'>Bidder only</option><option value="none"'+(s.draw==='none'?' selected':'')+'>Nobody</option></select></div>'+
  '<div class="setting"><span class="k">Enforce reneging</span><select id="sRen"><option value="1"'+(s.enforceRenege?' selected':'')+'>Yes</option><option value="0"'+(!s.enforceRenege?' selected':'')+'>No</option></select></div>'+
  '<div class="setting"><span class="k">Dealer may hold</span><select id="sHold"><option value="1"'+(s.dealerHold?' selected':'')+'>Yes</option><option value="0"'+(!s.dealerHold?' selected':'')+'>No</option></select></div>'+
  '<div class="row" style="margin-top:16px"><button class="btn solid" id="saveS">Save</button><button class="btn quiet" id="closeS">Cancel</button></div></div>');
  el('saveS').onclick=()=>{
    send({type:'settings', settings:{
      target:Math.max(6,Math.min(200,+el('sTarget').value||31)),
      defendersScore:el('sDef').value==='1',
      draw:el('sDraw').value,
      kitty:Number(el('sKitty').value),
      enforceRenege:el('sRen').value==='1',
      dealerHold:el('sHold').value==='1'
    }});
    closeOv();
  };
  el('closeS').onclick=closeOv;
};

applyDeck(currentDeck());
connect(()=>{
  const code=roomFromUrl();
  const returning = code && store.token && store.lastCode===code;
  if(returning) rejoin(); else renderLobby(true);
});
renderLobby(true);
