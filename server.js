'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const R = require('./game');

const PORT = process.env.PORT || 3000;
const PUB  = path.join(__dirname, 'public');

/* ---------------- static file server ---------------- */
const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.ico':'image/x-icon'};
const server = http.createServer((req,res) => {
  const url = (req.url||'/').split('?')[0];
  let file = url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[/\\])+/,'').slice(1);
  let full = path.join(PUB, file);
  const missing = !full.startsWith(PUB) || !fs.existsSync(full) || fs.statSync(full).isDirectory();
  if(missing){
    // Only routes fall through to the app. A missing asset must 404, never come
    // back as HTML — that silently breaks /t/CODE deep links.
    if(path.extname(file)){
      res.writeHead(404, {'Content-Type':'text/plain'});
      return res.end('Not found');
    }
    full = path.join(PUB,'index.html');
  }
  res.writeHead(200, {'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream'});
  fs.createReadStream(full).pipe(res);
});

/* ---------------- rooms ---------------- */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(){
  let c;
  do { c = Array.from({length:4}, () => CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]).join(''); }
  while(rooms.has(c));
  return c;
}

const DEFAULTS = { target:31, defendersScore:true, setPenalty:'quota',
                   enforceRenege:true, dealerHold:true, draw:'everyone', thirdHigh:'probe' };

function createRoom(){
  const code = newCode();
  const room = {
    code,
    seats: [null,null,null,null],   // {token, name, bot, sockets:Set, away}
    hostToken: null,
    settings: {...DEFAULTS},
    G: null,
    log: [],
    timer: null,
    touched: Date.now()
  };
  rooms.set(code, room);
  return room;
}

const teamOf = s => s % 2;
const TEAMNAME = ['Us','Them'];
const nameOf = (room,s) => room.seats[s] ? room.seats[s].name : 'Bot '+(s+1);

function log(room, html, cls){
  room.log.unshift({html, cls: cls||''});
  if(room.log.length > 80) room.log.pop();
}

/* ---------------- hand lifecycle ---------------- */
function startGame(room){
  room.G = { scores:[0,0], dealer:Math.floor(Math.random()*4), handNo:0, phase:'idle' };
  room.log = [];
  log(room, 'New game to '+room.settings.target+'. '+nameOf(room,room.G.dealer)+' deals first.', 'deal');
  dealHand(room);
}

function dealHand(room){
  const G = room.G;
  G.handNo++;
  const d = R.shuffle(R.fullDeck());
  G.hands = [[],[],[],[]];
  for(const chunk of [3,2])                      // three then two, dealer's left first
    for(let k=0;k<4;k++){
      const p = (G.dealer+1+k)%4;
      for(let n=0;n<chunk;n++) G.hands[p].push(d.pop());
    }
  for(let p=0;p<4;p++) G.hands[p].sort(R.sortForDisplay(null));
  G.stock = d;
  G.bids = [null,null,null,null];
  G.highBid = null; G.trump = null;
  G.trick = []; G.trickNo = 0; G.leader = null;
  G.units = [0,0]; G.highTrump = null;
  G.bidsSeen = 0;
  G.drawers = []; G.drawQueue = []; G.drawingWho = null;
  G.drawInfo = [null,null,null,null];
  G.result = null;
  G.resolving = false;
  G.phase = 'bidding';
  G.turn = (G.dealer+1)%4;
  log(room, 'Hand '+G.handNo+' — <b>'+nameOf(room,G.dealer)+'</b> deals, <b>'+nameOf(room,(G.dealer+1)%4)+'</b> opens the bidding.', 'deal');
  push(room); drive(room);
}

function placeBid(room, seat, value, isHold){
  const G = room.G;
  if(G.phase!=='bidding' || G.turn!==seat) return;
  const cur = G.highBid ? G.highBid.value : 0;
  if(value !== null){
    const holdOk = isHold && room.settings.dealerHold && seat===G.dealer && G.highBid && value===cur;
    if(!holdOk && !(value>cur && [15,20,25,30].includes(value))) return;
    G.bids[seat] = value;
    G.highBid = {value, seat};
    log(room, '<b>'+nameOf(room,seat)+'</b> '+(holdOk?'holds at':'bids')+' <b>'+value+'</b>.', 'hi');
  } else {
    G.bids[seat] = 'pass';
    log(room, '<b>'+nameOf(room,seat)+'</b> passes.');
  }
  G.bidsSeen++;
  if(value===30 || G.bidsSeen>=4) return closeAuction(room);
  G.turn = (G.turn+1)%4;
  push(room); drive(room);
}

function closeAuction(room){
  const G = room.G;
  if(!G.highBid){                                 // passed round — dealer is stuck at 15
    G.highBid = {value:15, seat:G.dealer, stuck:true};
    G.bids[G.dealer] = 15;
    log(room, 'Passed round to <b>'+nameOf(room,G.dealer)+'</b> — stuck at <b>15</b>.', 'hi');
  }
  G.phase = 'naming';
  G.turn = G.highBid.seat;
  push(room); drive(room);
}

function nameTrump(room, seat, t){
  const G = room.G;
  if(G.phase!=='naming' || G.highBid.seat!==seat || !R.SUITS.includes(t)) return;
  G.trump = t;
  for(let p=0;p<4;p++) G.hands[p].sort(R.sortForDisplay(t));
  log(room, '<b>'+nameOf(room,seat)+'</b> calls <b>'+R.SUITNAME[t]+'</b> '+R.GLYPH[t]+
            ' — needs '+R.quotaFor(G.highBid.value)+' of 6.', 'hi');

  const s = room.settings;
  const drawers = (G.highBid.value===30 || s.draw==='none') ? []
                : s.draw==='bidder' ? [G.highBid.seat] : [0,1,2,3];
  if(!drawers.length) return startPlay(room);
  G.drawers = drawers;
  G.drawQueue = [];
  for(let k=0;k<4;k++){ const p=(G.dealer+1+k)%4; if(drawers.includes(p)) G.drawQueue.push(p); }
  G.phase = 'drawing';
  nextDrawer(room);
}

function nextDrawer(room){
  const G = room.G;
  if(!G.drawQueue.length){ G.drawingWho = null; push(room); return later(room, 420, () => startPlay(room)); }
  G.drawingWho = G.drawQueue[0];
  push(room); drive(room);
}

function doDiscard(room, seat, ids){
  const G = room.G;
  if(G.phase!=='drawing' || G.drawingWho!==seat) return;
  const drop = new Set(Array.isArray(ids) ? ids : []);
  G.hands[seat] = G.hands[seat].filter(c => !drop.has(c.id));
  const kept = G.hands[seat].length;
  while(G.hands[seat].length < 5 && G.stock.length) G.hands[seat].push(G.stock.pop());
  const drew = 5 - kept;
  G.hands[seat].sort(R.sortForDisplay(G.trump));
  G.drawInfo[seat] = {kept, drew};
  log(room, drew ? '<b>'+nameOf(room,seat)+'</b> keeps '+kept+', draws '+drew+'.'
                 : '<b>'+nameOf(room,seat)+'</b> stands pat on all five.');
  G.drawQueue.shift();
  nextDrawer(room);
}

function startPlay(room){
  const G = room.G;
  G.phase = 'playing';
  G.leader = G.highBid.seat;
  G.turn = G.leader;
  push(room); drive(room);
}

function playCard(room, seat, cardId){
  const G = room.G;
  if(G.phase!=='playing' || G.turn!==seat || G.resolving) return;
  const card = G.hands[seat].find(c => c.id===cardId);
  if(!card) return;
  const legal = R.legalMoves(G.hands[seat], G.trick, G.trump, room.settings.enforceRenege);
  if(!legal.some(c => c.id===card.id)) return;

  G.hands[seat] = G.hands[seat].filter(c => c.id!==card.id);
  G.trick.push({seat, card});
  if(G.trick.length===1) log(room, '<b>'+nameOf(room,seat)+'</b> leads '+card.r+R.GLYPH[card.s]+'.');
  if(R.isTrump(card, G.trump)){
    if(!G.highTrump || R.trumpStrength(card,G.trump) > R.trumpStrength(G.highTrump.card,G.trump))
      G.highTrump = {card, seat};
  }
  if(G.trick.length===4){
    // The finished trick sits on the table for a beat. G.turn still points at
    // whoever played last, so without this guard they could play a second card
    // into the pause — a double click was enough to empty a hand early.
    G.resolving = true;
    push(room);
    return later(room, 1400, () => finishTrick(room));
  }
  G.turn = (G.turn+1)%4;
  push(room); drive(room);
}

function finishTrick(room){
  const G = room.G;
  G.resolving = false;
  const w = R.trickWinner(G.trick, G.trump);
  G.units[teamOf(w.seat)]++;
  log(room, '<b>'+nameOf(room,w.seat)+'</b> takes trick '+(G.trickNo+1)+' with '+w.card.r+R.GLYPH[w.card.s]+'.');
  G.trick = []; G.trickNo++;
  G.leader = w.seat; G.turn = w.seat;
  if(G.trickNo===5) return scoreHand(room);
  push(room); drive(room);
}

function scoreHand(room){
  const G = room.G, s = room.settings;
  const bt = teamOf(G.highBid.seat), dt = 1-bt;
  const tricks = [G.units[0], G.units[1]];
  const htTeam = G.highTrump ? teamOf(G.highTrump.seat) : null;
  const units = [tricks[0], tricks[1]];
  if(htTeam !== null) units[htTeam]++;

  const quota = R.quotaFor(G.highBid.value);
  const made = units[bt] >= quota;
  const bidDelta = made ? (units[bt]===6 ? 9 : units[bt])
                        : (s.setPenalty==='quota' ? -quota : 0);
  const defDelta = s.defendersScore ? units[dt] : 0;
  G.scores[bt] += bidDelta;
  G.scores[dt] += defDelta;

  log(room, '<b>'+nameOf(room,G.highBid.seat)+'</b> bid '+G.highBid.value+' and took '+units[bt]+
            ' — '+(made?'made it':'set')+'.', 'hi');

  G.result = {bidderSeat:G.highBid.seat, bt, dt, quota, units, tricks, htTeam, made,
              bidDelta, defDelta, bid:G.highBid.value, trump:G.trump,
              highTrump: G.highTrump ? G.highTrump.card : null};
  G.phase = 'handover';
  const over = G.scores.findIndex(v => v >= s.target);
  if(over >= 0){ G.winner = over; G.phase = 'gameover'; }
  push(room);
}

function nextHand(room){
  const G = room.G;
  if(G.phase!=='handover') return;
  G.dealer = (G.dealer+1)%4;
  G.phase = 'shuffling';
  G.trick = []; G.hands = [[],[],[],[]]; G.highBid = null; G.trump = null;
  G.bids = [null,null,null,null]; G.units=[0,0]; G.highTrump=null; G.trickNo=0;
  G.drawInfo = [null,null,null,null]; G.drawingWho = null; G.result = null;
  push(room);
  later(room, 820, () => dealHand(room));
}

/* ---------------- bot driver ---------------- */
function later(room, ms, fn){
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { room.timer = null; try{ fn(); }catch(e){ console.error(e); } }, ms);
}
// An empty seat, or one whose player dropped, is played by a bot so the table never stalls.
const isBot = (room, seat) => !room.seats[seat] || room.seats[seat].bot || room.seats[seat].away;

function drive(room){
  const G = room.G;
  // A room owns a single timer, so scheduling here while a beat is already
  // pending would cancel it. Never step on the end-of-trick pause.
  if(!G || G.resolving || room.timer) return;
  const s = room.settings;
  if(G.phase==='bidding' && isBot(room, G.turn)){
    const seat = G.turn;
    return later(room, 700, () => {
      const b = R.botBid(G.hands[seat], {highBid:G.highBid, seat, isDealer:seat===G.dealer, dealerHold:s.dealerHold});
      placeBid(room, seat, b.value, b.hold);
    });
  }
  if(G.phase==='naming' && isBot(room, G.highBid.seat)){
    const seat = G.highBid.seat;
    return later(room, 650, () => nameTrump(room, seat, R.botTrump(G.hands[seat])));
  }
  if(G.phase==='drawing' && G.drawingWho!==null && isBot(room, G.drawingWho)){
    const seat = G.drawingWho;
    return later(room, 560, () => doDiscard(room, seat, R.botDiscard(G.hands[seat], G.trump)));
  }
  if(G.phase==='playing' && isBot(room, G.turn)){
    const seat = G.turn;
    return later(room, 750, () => {
      const kept = p => (G.drawInfo && G.drawInfo[p]) ? G.drawInfo[p].kept : null;
      const sum = (a,b) => (kept(a)==null||kept(b)==null) ? null : kept(a)+kept(b);
      const card = R.botPlay(G.hands[seat], G.trick, G.trump, {
        seat, trickNo:G.trickNo, highBid:G.highBid, enforce:s.enforceRenege,
        thirdHigh:s.thirdHigh, onContract: teamOf(G.highBid.seat)===teamOf(seat),
        teamKept: sum(seat,(seat+2)%4), oppKept: sum((seat+1)%4,(seat+3)%4)
      });
      playCard(room, seat, card.id);
    });
  }
}

/* ---------------- per-seat views ---------------- */
function viewFor(room, mySeat){
  const G = room.G;
  const base = {
    code: room.code,
    settings: room.settings,
    mySeat,
    isHost: false,
    seats: room.seats.map((p,i) => ({
      seat: i,
      name: p ? p.name : null,
      bot: !p || p.bot,
      away: p ? p.away : false,
      empty: !p
    })),
    log: room.log.slice(0,40)
  };
  if(!G){ base.phase = 'lobby'; return base; }
  return Object.assign(base, {
    phase: G.phase,
    handNo: G.handNo,
    dealer: G.dealer,
    turn: G.turn,
    trump: G.trump,
    highBid: G.highBid,
    bids: G.bids,
    trick: G.trick,
    trickNo: G.trickNo,
    units: G.units,
    scores: G.scores,
    highTrumpSeat: G.highTrump ? G.highTrump.seat : null,
    drawingWho: G.drawingWho,
    drawInfo: G.drawInfo,
    counts: G.hands.map(h => h.length),
    result: G.result,
    winner: G.winner,
    // Only ever your own cards leave the server.
    hand: mySeat===null ? [] : G.hands[mySeat],
    resolving: !!G.resolving,
    legal: (mySeat!==null && G.phase==='playing' && G.turn===mySeat && !G.resolving)
      ? R.legalMoves(G.hands[mySeat], G.trick, G.trump, room.settings.enforceRenege).map(c => c.id)
      : null
  });
}

function push(room){
  room.touched = Date.now();
  for(let s=0;s<4;s++){
    const p = room.seats[s];
    if(!p || p.bot) continue;
    const v = viewFor(room, s);
    v.isHost = p.token === room.hostToken;
    const msg = JSON.stringify({type:'state', view:v});
    for(const ws of p.sockets) if(ws.readyState===1) ws.send(msg);
  }
  for(const ws of room.watchers || []){
    if(ws.readyState===1) ws.send(JSON.stringify({type:'state', view:viewFor(room,null)}));
  }
}

/* ---------------- websocket plumbing ---------------- */
const wss = new WebSocketServer({ server });

function seatOfToken(room, token){
  for(let s=0;s<4;s++) if(room.seats[s] && room.seats[s].token===token) return s;
  return null;
}
function send(ws, obj){ if(ws.readyState===1) ws.send(JSON.stringify(obj)); }

wss.on('connection', ws => {
  ws.room = null; ws.token = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room;

    if(m.type==='create'){
      const r = createRoom();
      r.watchers = new Set();
      const token = m.token || crypto.randomUUID();
      r.seats[0] = {token, name:(m.name||'Player').slice(0,14), bot:false, sockets:new Set([ws]), away:false};
      r.hostToken = token;
      ws.room = r; ws.token = token;
      send(ws, {type:'joined', code:r.code, token, seat:0});
      log(r, '<b>'+r.seats[0].name+'</b> opened the table.');
      return push(r);
    }

    if(m.type==='join'){
      const r = rooms.get(String(m.code||'').toUpperCase());
      if(!r) return send(ws, {type:'error', message:'No table with that code. Check the link or ask for a new one.'});
      r.watchers = r.watchers || new Set();
      const token = m.token || crypto.randomUUID();
      ws.room = r; ws.token = token;
      let seat = seatOfToken(r, token);
      if(seat !== null){                                  // reconnecting to your own seat
        r.seats[seat].sockets.add(ws);
        r.seats[seat].away = false;
      } else {
        seat = r.seats.findIndex(p => !p);
        if(seat === -1){ r.watchers.add(ws); send(ws, {type:'joined', code:r.code, token, seat:null}); return push(r); }
        r.seats[seat] = {token, name:(m.name||'Player').slice(0,14), bot:false, sockets:new Set([ws]), away:false};
        if(!r.hostToken) r.hostToken = token;
        log(r, '<b>'+r.seats[seat].name+'</b> sits down.');
      }
      send(ws, {type:'joined', code:r.code, token, seat});
      return push(r);
    }

    if(!room) return;
    const seat = seatOfToken(room, ws.token);
    const host = ws.token === room.hostToken;

    switch(m.type){
      case 'settings':
        if(host && (!room.G || room.G.phase==='lobby')) Object.assign(room.settings, m.settings||{});
        else if(host) Object.assign(room.settings, m.settings||{});
        return push(room);
      case 'sit': {
        // Seats can be swapped freely until the first hand is dealt.
        if(room.G || seat===null) return;
        const to = Number(m.seat);
        if(!(to>=0 && to<4) || to===seat || room.seats[to]) return;
        room.seats[to] = room.seats[seat];
        room.seats[seat] = null;
        if(!room.hostToken) room.hostToken = room.seats[to].token;
        log(room, '<b>'+room.seats[to].name+'</b> moves to seat '+(to+1)+
                  ' ('+(to%2===0?'Team A':'Team B')+').');
        return push(room);
      }
      case 'start':
        if(host) startGame(room);
        return;
      case 'bid':
        if(seat!==null) placeBid(room, seat, m.value===null?null:Number(m.value), !!m.hold);
        return;
      case 'trump':
        if(seat!==null) nameTrump(room, seat, m.suit);
        return;
      case 'discard':
        if(seat!==null) doDiscard(room, seat, m.ids);
        return;
      case 'play':
        if(seat!==null) playCard(room, seat, m.cardId);
        return;
      case 'next':
        if(seat!==null) nextHand(room);
        return;
      case 'newgame':
        if(host) startGame(room);
        return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if(!room) return;
    if(room.watchers) room.watchers.delete(ws);
    const seat = seatOfToken(room, ws.token);
    if(seat !== null){
      const p = room.seats[seat];
      p.sockets.delete(ws);
      if(!p.sockets.size){
        p.away = true;                 // seat is held for a reconnect; a bot covers the turn
        log(room, '<b>'+p.name+'</b> dropped — a bot is covering the seat.');
      }
    }
    push(room);
    drive(room);
  });
});

/* Housekeeping: drop tables nobody has touched in 90 minutes. */
setInterval(() => {
  for(const [code,r] of rooms)
    if(Date.now() - r.touched > 1000*60*90){ clearTimeout(r.timer); rooms.delete(code); }
}, 60000);

/* Watchdog. A room owns a single timer, so a lost or stomped beat would freeze
   the table for good. Every couple of seconds, nudge any room that has nothing
   scheduled but still owes somebody an action. */
setInterval(() => {
  for(const r of rooms.values()){
    const G = r.G;
    if(!G || r.timer) continue;                    // a beat is already on its way
    if(G.resolving && G.trick.length === 4){
      console.warn('[watchdog] lost end-of-trick beat, room', r.code);
      finishTrick(r);
    } else if(G.phase === 'shuffling'){
      console.warn('[watchdog] lost deal, room', r.code);
      dealHand(r);
    } else {
      drive(r);
    }
  }
}, 2500);

server.listen(PORT, () => console.log('45s table running on http://localhost:'+PORT));
