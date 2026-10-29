'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const R = require('./game');
const SOLVER = require('./solver');

const PORT = process.env.PORT || 3000;
const PUB  = path.join(__dirname, 'public');

/* ---------------- static file server ---------------- */
const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.ico':'image/x-icon',
               '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
               '.webp':'image/webp', '.svg':'image/svg+xml'};
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
let chatId = 0;

/* Profiles are made by whoever sits down: type a name once and it joins the
   list everyone picks from afterwards. */
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 '\-]{0,13}$/;
const roster = () => Object.keys(profiles);
const findName = want =>
  roster().find(n => n.toLowerCase() === String(want||'').trim().toLowerCase());

/* An emoji each, kept by name and written to disk so a pick outlives a
   restart. Each browser also remembers its own and offers it again on join,
   so a choice comes back even if the file is lost. */
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch {}
/* Lifetime record, by name. Same idea as the emoji: kept on disk so it
   outlives a restart. */
const STATS_FILE = path.join(__dirname, 'stats.json');
let stats = {};
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch {}
const blank = () => ({games:0, wins:0, hands:0, books:0, points:0, bids:0, made:0, set:0});
/* Two records per player: hands against a full table of people, and hands with
   at least one bot in a seat. A hand only counts as against people if all four
   seats were human when the first book was played. */
function rec(name, mode){
  let s = stats[name];
  if(!s) s = stats[name] = {};
  if(s.games !== undefined) s = stats[name] = {bots:s, pvp:blank()};   // older flat record
  s[mode] = s[mode] || blank();
  return s[mode];
}
let statsSaveTimer = null;
function saveStats(){
  clearTimeout(statsSaveTimer);
  statsSaveTimer = setTimeout(() => {
    fs.writeFile(STATS_FILE, JSON.stringify(stats), e => { if(e) console.error('[stats]', e.message); });
  }, 600);
}
/* Only real players have a record — bots filling empty seats do not. */
const humanAt = (room, s) => (room.seats[s] && !room.seats[s].bot) ? room.seats[s].name : null;
const sendStats = ws => send(ws, {type:'stats', map:stats});

function broadcastProfiles(origin){
  if(origin) sendProfiles(origin);                  // the sender may not be seated yet
  for(const r of rooms.values()){
    for(const p of r.seats) if(p) for(const sk of p.sockets) sendProfiles(sk);
    for(const sk of (r.watchers || [])) sendProfiles(sk);
  }
}

let profileSaveTimer = null;
function saveProfiles(){
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => {
    fs.writeFile(PROFILES_FILE, JSON.stringify(profiles), e => { if(e) console.error('[profiles]', e.message); });
  }, 400);
}
const sendProfiles = ws => send(ws, {type:'profiles', roster:roster(), map:profiles});
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(){
  let c;
  do { c = Array.from({length:4}, () => CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]).join(''); }
  while(rooms.has(c));
  return c;
}

const DEFAULTS = { target:31, defendersScore:true, setPenalty:'quota',
                   enforceRenege:true, dealerHold:true, draw:'everyone', kitty:0, thirdHigh:'probe' };

function createRoom(){
  const code = newCode();
  const room = {
    code,
    seats: [null,null,null,null],   // {token, name, bot, sockets:Set, away}
    hostToken: null,
    settings: {...DEFAULTS},
    G: null,
    log: [],
    chat: [],
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
  G.dealPattern = Math.random() < 0.5 ? [3,2] : [2,3];   // three then two, or two then three
  for(const chunk of G.dealPattern)
    for(let k=0;k<4;k++){
      const p = (G.dealer+1+k)%4;
      for(let n=0;n<chunk;n++) G.hands[p].push(d.pop());
    }
  for(let p=0;p<4;p++) G.hands[p].sort(R.sortForDisplay(null));
  // The kitty: cards face down in the middle for whoever buys the hand.
  G.kitty = [];
  const kn = Number(room.settings.kitty) || 0;
  for(let i=0;i<kn && d.length;i++) G.kitty.push(d.pop());
  G.stock = d;
  G.bids = [null,null,null,null];
  G.highBid = null; G.trump = null;
  G.trick = []; G.trickNo = 0; G.leader = null;
  G.units = [0,0]; G.highTrump = null;
  G.bidsSeen = 0;
  G.drawers = []; G.pending = [null,null,null,null];
  G.drawInfo = [null,null,null,null];
  G.result = null;
  G.resolving = false;
  G.seen = [];            // every card played this hand
  G.voidTrump = {};       // seats that have shown out of trump
  G.decl = null;
  G.phase = 'bidding';
  G.turn = (G.dealer+1)%4;
  log(room, 'Hand '+G.handNo+' — <b>'+nameOf(room,G.dealer)+'</b> deals, <b>'+nameOf(room,(G.dealer+1)%4)+'</b> opens the bidding.', 'deal');
  push(room); drive(room);
}

/* The dealer may take the bid at the standing number — but not when a kitty is
   in play, where buying it for nothing would be far too strong. */
const holdAllowed = room => room.settings.dealerHold && !Number(room.settings.kitty);

function placeBid(room, seat, value, isHold){
  const G = room.G;
  if(G.phase!=='bidding' || G.turn!==seat) return;
  const cur = G.highBid ? G.highBid.value : 0;
  if(value !== null){
    const holdOk = isHold && holdAllowed(room) && seat===G.dealer && G.highBid && value===cur;
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
  if(G.kitty && G.kitty.length){
    G.hands[G.highBid.seat] = G.hands[G.highBid.seat].concat(G.kitty);
    G.hands[G.highBid.seat].sort(R.sortForDisplay(t));
    log(room, '<b>'+nameOf(room,G.highBid.seat)+'</b> takes the kitty — '+
              G.kitty.length+' card'+(G.kitty.length>1?'s':'')+'.');
    G.kitty = [];
  }
  const drawers = (G.highBid.value===30 || s.draw==='none') ? []
                : s.draw==='bidder' ? [G.highBid.seat] : [0,1,2,3];
  if(!drawers.length){
    if(G.hands[G.highBid.seat].length > 5){     // took a kitty on a 30
      G.drawers = [G.highBid.seat];
      G.pending = [null,null,null,null];
      G.phase = 'drawing';
      push(room); return drive(room);
    }
    return startPlay(room);
  }
  G.drawers = drawers;
  G.pending = [null,null,null,null];          // each player's chosen discards
  G.phase = 'drawing';
  push(room); drive(room);
}

// Who still has to lock in a discard?
const waitingOn = G => G.drawers.filter(p => !G.pending[p]);

function doDiscard(room, seat, ids){
  const G = room.G;
  if(G.phase!=='drawing' || !G.drawers.includes(seat) || G.pending[seat]) return;
  const list = Array.isArray(ids) ? ids : [];
  if(new Set(list).size !== list.length) return;
  if(!list.every(id => G.hands[seat].some(c => c.id===id))) return;
  if(G.hands[seat].length - list.length > 5) return;   // must come down to five
  G.pending[seat] = list;                     // locked in, but nothing is dealt yet
  log(room, '<b>'+nameOf(room,seat)+'</b> is ready.');
  if(waitingOn(G).length){ push(room); return drive(room); }
  G.resolving = true; push(room);
  later(room, 450, () => serveDraws(room), 'serveDraws');
}

/* Everyone has chosen. Now the dealer serves, starting on their left and
   dealing to themselves last. */
function serveDraws(room){
  const G = room.G;
  G.resolving = false;
  for(let k=0;k<4;k++){
    const seat = (G.dealer+1+k)%4;             // dealer is k===3, so they come last
    if(!G.drawers.includes(seat)) continue;
    const drop = new Set(G.pending[seat] || []);
    G.hands[seat] = G.hands[seat].filter(c => !drop.has(c.id));
    const kept = G.hands[seat].length;
    while(G.hands[seat].length < 5 && G.stock.length) G.hands[seat].push(G.stock.pop());
    const drew = 5 - kept;
    G.hands[seat].sort(R.sortForDisplay(G.trump));
    G.drawInfo[seat] = {kept, drew};
    log(room, drew ? '<b>'+nameOf(room,seat)+'</b> keeps '+kept+', draws '+drew+'.'
                   : '<b>'+nameOf(room,seat)+'</b> stands pat on all five.');
  }
  G.pending = [null,null,null,null];
  startPlay(room);
}

function startPlay(room){
  const G = room.G;
  // Keep the deal as it stands now: with every hand known, the whole five
  // tricks can be solved exactly afterwards for the review.
  G.startHands = G.hands.map(h => h.slice());
  G.history = [];
  G.declared = false;
  G.phase = 'playing';
  G.leader = G.highBid.seat;
  G.turn = G.leader;
  push(room); drive(room);
}

/* Public memory of the hand: what has been played, and who has shown out.
   Failing to follow a suit proves a void in it — on a trump lead that is only
   true up to the three cards a player is allowed to renege, which the bots
   account for separately. */
function noteCard(G, seat, card){
  G.seen.push(card.id);
  if(G.trick.length > 1){
    const led = R.effSuit(G.trick[0].card, G.trump);
    if(R.effSuit(card, G.trump) !== led && led === G.trump) G.voidTrump[seat] = true;
  }
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
  noteCard(G, seat, card);
  if(G.history) G.history.push({seat, card});
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
    return later(room, 1400, () => finishTrick(room), 'finishTrick');
  }
  G.turn = (G.turn+1)%4;
  push(room); drive(room);
}

/* ---------------- leading the top trumps together ---------------- */
function declare(room, seat, count){
  const G = room.G;
  if(G.phase!=='playing' || G.turn!==seat || G.trick.length || G.resolving) return;
  const max = R.declarable(G.hands[seat], G.trump, 5-G.trickNo);
  if(!count || count > max) return;
  const cards = R.declareCards(G.hands[seat], G.trump, count);
  const ids = new Set(cards.map(c => c.id));
  G.hands[seat] = G.hands[seat].filter(c => !ids.has(c.id));
  G.decl = {leader:seat, count, cards:[[],[],[],[]], turn:(seat+1)%4};
  G.decl.cards[seat] = cards;
  log(room, '<b>'+nameOf(room,seat)+'</b> leads '+cards.map(c => c.r+R.GLYPH[c.s]).join(' + ')+
            ' — everyone plays '+count+'.', 'hi');
  G.phase = 'declaring';
  push(room); drive(room);
}

function contribute(room, seat, ids){
  const G = room.G;
  if(G.phase!=='declaring' || !G.decl || G.resolving || G.decl.turn!==seat) return;
  if(!R.validContribution(G.hands[seat], G.trump, G.decl.count, ids)) return;
  const set = new Set(ids);
  G.decl.cards[seat] = G.hands[seat].filter(c => set.has(c.id));
  G.hands[seat] = G.hands[seat].filter(c => !set.has(c.id));
  for(const c of G.decl.cards[seat]) G.seen.push(c.id);
  G.declared = true;                      // a declaration is several cards at once

  if(G.decl.cards[seat].some(c => !R.isTrump(c, G.trump))) G.voidTrump[seat] = true;
  log(room, '<b>'+nameOf(room,seat)+'</b> plays '+
            G.decl.cards[seat].map(c => c.r+R.GLYPH[c.s]).join(' ')+'.');
  const next = (seat+1)%4;
  if(next === G.decl.leader){
    // Everyone has contributed. Close the turn so a second click can't strip
    // another card out of the last player's hand.
    G.decl.turn = null;
    G.resolving = true;
    push(room);
    return later(room, 1600, () => resolveDeclare(room), 'resolveDeclare');
  }
  G.decl.turn = next;
  push(room); drive(room);
}

function resolveDeclare(room){
  const G = room.G, d = G.decl;
  G.resolving = false;
  G.units[teamOf(d.leader)] += d.count;
  // Nothing outranks the 5, so the leader also owns the high trump.
  G.highTrump = {card:d.cards[d.leader][0], seat:d.leader};
  G.trickNo += d.count;
  log(room, '<b>'+nameOf(room,d.leader)+'</b> takes '+d.count+' tricks on the declaration.');
  G.decl = null; G.phase = 'playing'; G.trick = [];
  G.leader = d.leader; G.turn = d.leader;
  if(G.trickNo >= 5) return scoreHand(room);
  push(room); drive(room);
}

function finishTrick(room){
  const G = room.G;
  G.resolving = false;
  // Decided on the first book: four people, or anything less.
  if(G.trickNo === 0)
    G.mode = [0,1,2,3].every(s => humanAt(room, s)) ? 'pvp' : 'bots';
  const w = R.trickWinner(G.trick, G.trump);
  G.units[teamOf(w.seat)]++;
  const booker = humanAt(room, w.seat);
  if(booker){ rec(booker, G.mode||'bots').books++; saveStats(); }
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

  for(let s=0;s<4;s++){
    const nm = humanAt(room, s);
    if(!nm) continue;
    const r = rec(nm, G.mode||'bots');
    r.hands++;
    r.points += (teamOf(s) === bt) ? bidDelta : defDelta;
    if(s === G.highBid.seat){ r.bids++; if(made) r.made++; else r.set++; }
  }
  saveStats();

  G.result = {bidderSeat:G.highBid.seat, bt, dt, quota, units, tricks, htTeam, made,
              bidDelta, defDelta, bid:G.highBid.value, trump:G.trump,
              highTrump: G.highTrump ? G.highTrump.card : null};
  G.phase = 'handover';
  const over = G.scores.findIndex(v => v >= s.target);
  if(over >= 0){
    G.winner = over; G.phase = 'gameover';
    for(let p=0;p<4;p++){
      const nm = humanAt(room, p);
      if(!nm) continue;
      const r = rec(nm, G.mode||'bots');
      r.games++;
      if(teamOf(p) === over) r.wins++;
    }
    saveStats();
  }
  push(room);
}

function nextHand(room){
  const G = room.G;
  if(G.phase!=='handover') return;
  G.dealer = (G.dealer+1)%4;
  G.phase = 'shuffling';
  G.trick = []; G.hands = [[],[],[],[]]; G.highBid = null; G.trump = null;
  G.bids = [null,null,null,null]; G.units=[0,0]; G.highTrump=null; G.trickNo=0;
  G.drawInfo = [null,null,null,null]; G.pending = [null,null,null,null]; G.result = null;
  push(room);
  later(room, 820, () => dealHand(room), 'dealHand');
}

/* ---------------- bot driver ---------------- */
const SPEED = Math.max(1, Number(process.env.SPEED) || 1);   // >1 speeds up bot pacing, for tests
function later(room, ms, fn, tag){
  ms = Math.max(20, Math.round(ms / SPEED));
  if(room.timer) console.warn('[timer] CLEARED pending '+(room.tag||'?')+' to arm '+(tag||'?'));
  clearTimeout(room.timer);
  const armed = Date.now();
  room.tag = tag;
  room.timer = setTimeout(() => {
    const late = Date.now()-armed-ms;
    if(late > 500) console.warn('[timer] '+(tag||'?')+' fired '+late+'ms late (wanted '+ms+'ms)');
    room.timer = null;
    try{ fn(); }catch(e){ console.error('[timer] '+(tag||'?')+' threw', e); }
  }, ms);
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
        const b = R.botBid(G.hands[seat], {highBid:G.highBid, seat,
        isDealer:seat===G.dealer, dealerHold:holdAllowed(room)});
      placeBid(room, seat, b.value, b.hold);
    }, 'botBid');
  }
  if(G.phase==='naming' && isBot(room, G.highBid.seat)){
    const seat = G.highBid.seat;
    return later(room, 650, () => nameTrump(room, seat, R.botTrump(G.hands[seat])), 'botTrump');
  }
  if(G.phase==='drawing'){
    const seat = waitingOn(G).find(p => isBot(room, p));
    if(seat !== undefined)
      return later(room, 420, () => {
        let ids = R.botDiscard(G.hands[seat], G.trump);
        const over = G.hands[seat].length - ids.length - 5;
        if(over > 0){                           // holding a kitty: shed the weakest trumps too
          const keep = G.hands[seat].filter(c => !ids.includes(c.id))
            .sort((x,y) => R.power(y,G.trump) - R.power(x,G.trump));
          ids = ids.concat(keep.slice(5).map(c => c.id));
        }
        doDiscard(room, seat, ids);
      });
    return;                                    // only humans left to lock in
  }
  if(G.phase==='declaring' && G.decl && isBot(room, G.decl.turn)){
    const seat = G.decl.turn;
    return later(room, 620, () =>
      contribute(room, seat, R.botContribution(G.hands[seat], G.trump, G.decl.count)));
  }
  if(G.phase==='playing' && isBot(room, G.turn)){
    const seat = G.turn;
    if(!G.trick.length){
      const max = R.declarable(G.hands[seat], G.trump, 5-G.trickNo);
      if(max) return later(room, 700, () => declare(room, seat, max), 'botDeclare');
    }
    return later(room, 750, () => {
      const kept = p => (G.drawInfo && G.drawInfo[p]) ? G.drawInfo[p].kept : null;
      const sum = (a,b) => (kept(a)==null||kept(b)==null) ? null : kept(a)+kept(b);
      const card = R.botPlay(G.hands[seat], G.trick, G.trump, {
        seat, trickNo:G.trickNo, highBid:G.highBid, enforce:s.enforceRenege,
        thirdHigh:s.thirdHigh, onContract: teamOf(G.highBid.seat)===teamOf(seat),
        teamKept: sum(seat,(seat+2)%4), oppKept: sum((seat+1)%4,(seat+3)%4),
        seen: new Set(G.seen), voidTrump: G.voidTrump,
        acted: G.trick.map(p => p.seat)
      });
      if(!card){ console.error('[bug] no legal card for seat', seat, 'hand', G.hands[seat].length); return; }
      playCard(room, seat, card.id);
    }, 'botPlay');
  }
}

/* ---------------- per-seat views ---------------- */
function viewFor(room, mySeat){
  const G = room.G;
  const base = {
    code: room.code,
    settings: room.settings,
    holdAllowed: holdAllowed(room),
    mySeat,
    isHost: false,
    seats: room.seats.map((p,i) => ({
      seat: i,
      name: p ? p.name : null,
      bot: !p || p.bot,
      away: p ? p.away : false,
      empty: !p
    })),
    log: room.log.slice(0,40),
    chat: room.chat.slice(-12)
  };
  if(!G){ base.phase = 'lobby'; return base; }
  return Object.assign(base, {
    phase: G.phase,
    handNo: G.handNo,
    dealer: G.dealer,
    dealPattern: G.dealPattern,
    turn: G.turn,
    trump: G.trump,
    highBid: G.highBid,
    bids: G.bids,
    trick: G.trick,
    trickNo: G.trickNo,
    units: G.units,
    scores: G.scores,
    highTrumpSeat: G.highTrump ? G.highTrump.seat : null,
    ready: G.pending ? G.pending.map(p => !!p) : [false,false,false,false],
    drawers: G.drawers || [],
    kitty: (G.kitty || []).length,
    mustShed: (mySeat!==null && G.hands[mySeat]) ? Math.max(0, G.hands[mySeat].length-5) : 0,
    iAmReady: mySeat!==null && !!(G.pending && G.pending[mySeat]),
    waitingCount: (G.phase==='drawing' && G.drawers) ? waitingOn(G).length : 0,
    drawInfo: G.drawInfo,
    counts: G.hands.map(h => h.length),
    result: G.result,
    winner: G.winner,
    // Only ever your own cards leave the server.
    hand: mySeat===null ? [] : G.hands[mySeat],
    resolving: !!G.resolving,
    decl: G.decl ? {leader:G.decl.leader, count:G.decl.count, turn:G.decl.turn,
                    cards:G.decl.cards} : null,
    canDeclare: (mySeat!==null && G.phase==='playing' && G.turn===mySeat &&
                 !G.trick.length && !G.resolving)
      ? R.declarable(G.hands[mySeat], G.trump, 5-G.trickNo) : 0,
    mustPlay: (mySeat!==null && G.phase==='declaring' && G.decl && G.decl.turn===mySeat)
      ? {count:Math.min(G.decl.count, G.hands[mySeat].length),
         trumps:R.requiredTrumps(G.hands[mySeat], G.trump, G.decl.count)} : null,
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
  sendProfiles(ws);              // the roster, before anyone picks a name
  sendStats(ws);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room;

    if(m.type==='create'){
      const r = createRoom();
      r.watchers = new Set();
      const token = m.token || crypto.randomUUID();
      const host = findName(m.name);
      if(!host)
        return send(ws, {type:'error', message:'Pick a profile first, or make one.'});
      r.seats[0] = {token, name:host, bot:false, sockets:new Set([ws]), away:false};
      r.hostToken = token;
      ws.room = r; ws.token = token;
      sendProfiles(ws);
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
        const want = findName(m.name);
        if(!want)
          return send(ws, {type:'error', message:'Pick a profile first, or make one.'});
        if(r.seats.some(p => p && p.name === want))
          return send(ws, {type:'error', message:want+' is already at this table. Pick another profile.'});
        seat = m.seat!==undefined && m.seat!==null && !r.seats[m.seat] ? Number(m.seat)
             : r.seats.findIndex(p => !p);
        if(seat === -1 || !(seat>=0 && seat<4) || r.seats[seat]){
          r.watchers.add(ws); send(ws, {type:'joined', code:r.code, token, seat:null}); return push(r);
        }
        r.seats[seat] = {token, name:want, bot:false, sockets:new Set([ws]), away:false};
        if(!r.hostToken) r.hostToken = token;
        log(r, '<b>'+r.seats[seat].name+'</b> sits down.');
      }
      sendProfiles(ws);
      send(ws, {type:'joined', code:r.code, token, seat});
      return push(r);
    }

    if(m.type==='stats'){ return sendStats(ws); }
    if(m.type==='newprofile'){
        const want = String(m.name||'').trim().replace(/\s+/g,' ');
        if(!NAME_OK.test(want))
          return send(ws, {type:'error', message:'Names are up to 14 letters, numbers, spaces, apostrophes or hyphens.'});
        if(findName(want))
          return send(ws, {type:'error', message:'There is already a profile called '+findName(want)+'.'});
        profiles[want] = String(m.avatar||'🙂').slice(0,16);
        saveProfiles();
        broadcastProfiles(ws);
        return send(ws, {type:'profilemade', name:want});
      }
    if(m.type==='profile'){
        const name = findName(m.name);
        if(!name) return;
        const emoji = String(m.avatar||'');
        if(!emoji || emoji.length > 16) return;         // one emoji, not a sentence
        if(emoji) profiles[name] = emoji;
        saveProfiles();
        broadcastProfiles(ws);
      return;
    }

    if(!room) return;
    const seat = seatOfToken(room, ws.token);
    const host = ws.token === room.hostToken;

    switch(m.type){
      case 'settings': {
        if(!host) return;
        const up = m.settings || {};
        if(up.kitty!==undefined) up.kitty = Number(up.kitty) ? 3 : 0;   // on means three cards
        Object.assign(room.settings, up);
        return push(room);
      }
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
      case 'declare':
        if(seat!==null) declare(room, seat, Number(m.count));
        return;
      case 'contribute':
        if(seat!==null) contribute(room, seat, m.ids);
        return;
      case 'review': {
        if(seat===null || !room.G || !room.G.startHands) return;
        const G = room.G;
        if(G.phase!=='handover' && G.phase!=='gameover') return;
        if(G.declared) return send(ws, {type:'review', unavailable:'declaration'});
        try{
          const r = SOLVER.reviewHand({
            start: G.startHands, plays: G.history, trump: G.trump,
            leader: G.highBid.seat, seat, enforce: room.settings.enforceRenege
          });
          const took = G.result ? G.result.units[seat % 2] : null;
          return send(ws, {type:'review', par:r.par, took,
            notes:r.notes.map(n => ({
              trickNo: n.trickNo, card: n.card, cost: n.cost, lead: n.lead,
              better: n.better.map(c => c.id)
            }))});
        }catch(e){ console.error('[review]', e); return send(ws, {type:'review', unavailable:'error'}); }
      }
      case 'chat': {
        if(seat===null) return;                       // watchers listen only
        const text = String(m.text||'').replace(/\s+/g,' ').trim().slice(0,160);
        if(!text) return;
        const now = Date.now();
        const p = room.seats[seat];
        p.chatAt = p.chatAt || [];
        p.chatAt = p.chatAt.filter(t => now - t < 10000);
        if(p.chatAt.length >= 6) return;              // a light throttle
        p.chatAt.push(now);
        room.chat.push({seat, name:p.name, text, at:now, id:++chatId});
        if(room.chat.length > 60) room.chat.shift();
        return push(room);
      }
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
   try{
    const G = r.G;
    if(!G || r.timer) continue;                    // a beat is already on its way
    if(G.resolving && G.decl && G.decl.turn === null){
      console.warn('[watchdog] lost declaration beat, room', r.code);
      resolveDeclare(r);
    } else if(G.resolving && G.trick.length === 4){
      console.warn('[watchdog] lost end-of-trick beat, room', r.code);
      finishTrick(r);
    } else if(G.resolving && G.phase === 'drawing'){
      console.warn('[watchdog] lost draw beat, room', r.code);
      serveDraws(r);
    } else if(G.phase === 'shuffling'){
      console.warn('[watchdog] lost deal, room', r.code);
      dealHand(r);
    } else {
      drive(r);
    }
   }catch(e){ console.error('[watchdog] room', r.code, e); }   // never take the server down
  }
}, 2500);

server.listen(PORT, () => console.log('45s table running on http://localhost:'+PORT));
