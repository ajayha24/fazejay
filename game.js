'use strict';
/* Auction 45s — house rules engine. No DOM, runs on the server. */

const SUITS = ['S','H','D','C'];
const GLYPH = {S:'♠', H:'♥', D:'♦', C:'♣'};
const SUITNAME = {S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs'};
const RED = {H:1, D:1};
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

// Trump rank, high -> low. The ace of hearts is always the third-best trump.
const TRUMP_ORDER = {
  S:['5S','JS','AH','AS','KS','QS','2S','3S','4S','6S','7S','8S','9S','10S'],
  C:['5C','JC','AH','AC','KC','QC','2C','3C','4C','6C','7C','8C','9C','10C'],
  D:['5D','JD','AH','AD','KD','QD','10D','9D','8D','7D','6D','4D','3D','2D'],
  H:['5H','JH','AH','KH','QH','10H','9H','8H','7H','6H','4H','3H','2H']
};
// Plain-suit rank, high -> low. "Low in black, high in red."
const PLAIN_ORDER = {
  S:['KS','QS','JS','AS','2S','3S','4S','5S','6S','7S','8S','9S','10S'],
  C:['KC','QC','JC','AC','2C','3C','4C','5C','6C','7C','8C','9C','10C'],
  D:['KD','QD','JD','10D','9D','8D','7D','6D','5D','4D','3D','2D','AD'],
  H:['KH','QH','JH','10H','9H','8H','7H','6H','5H','4H','3H','2H']
};
const TOP3 = t => [TRUMP_ORDER[t][0], TRUMP_ORDER[t][1], 'AH'];

function fullDeck(){
  const out = [];
  for(const s of SUITS) for(const r of RANKS) out.push({r, s, id:r+s});
  return out;
}
function shuffle(d){
  for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}

const isTrump = (c,t) => c.s===t || c.id==='AH';
const trumpStrength = (c,t) => { const o=TRUMP_ORDER[t]; return o.length-o.indexOf(c.id); };
const plainStrength = c => { const o=PLAIN_ORDER[c.s]; return o.length-o.indexOf(c.id); };
const effSuit = (c,t) => isTrump(c,t) ? t : c.s;
const power = (c,t) => isTrump(c,t) ? 1000+trumpStrength(c,t) : plainStrength(c);
const quotaFor = b => b/5;                       // 15->3, 20->4, 25->5, 30->6

function sortForDisplay(t){
  return (a,b) => {
    if(t){
      const at=isTrump(a,t), bt=isTrump(b,t);
      if(at!==bt) return at?-1:1;
      if(at) return trumpStrength(b,t)-trumpStrength(a,t);
    }
    if(a.s!==b.s) return SUITS.indexOf(a.s)-SUITS.indexOf(b.s);
    return plainStrength(b)-plainStrength(a);
  };
}

/* Which cards may this hand legally play into this trick? */
function legalMoves(hand, trick, t, enforce){
  if(!trick.length) return hand.slice();
  if(enforce === false) return hand.slice();
  const led = trick[0].card, ledSuit = effSuit(led,t);
  const match = hand.filter(c => effSuit(c,t)===ledSuit);
  if(!match.length) return hand.slice();
  // Plain suit led: follow it OR trump it. Never forced to trump, never allowed
  // to throw off a third suit while holding the suit led.
  if(ledSuit!==t) return match.concat(hand.filter(c => isTrump(c,t)));
  // Trump led. The 5, the jack and the ace of hearts may be held back, but only
  // when BOTH hold: they are the only trumps you have left, AND they outrank the
  // card led. A higher one led drags a lower one out — lead the 5 and the jack
  // or the ace of hearts must fall; lead the jack and the ace of hearts must fall.
  const top = TOP3(t), ledPower = trumpStrength(led, t);
  const forced = match.filter(c => !(top.includes(c.id) && trumpStrength(c,t) > ledPower));
  return forced.length ? match : hand.slice();
}

/* Any trump beats the whole plain suit; otherwise high card of the suit led. */
function trickWinner(trick, t){
  const ledSuit = effSuit(trick[0].card, t);
  const trumps = trick.filter(pl => isTrump(pl.card,t));
  const pool = trumps.length ? trumps : trick.filter(pl => effSuit(pl.card,t)===ledSuit);
  let best = null;
  for(const pl of pool) if(!best || power(pl.card,t) > power(best.card,t)) best = pl;
  return best;
}

/* ---------------- bots ---------------- */
function evalSuit(hand, t){
  let v = 0;
  const n = TRUMP_ORDER[t].length;
  for(const c of hand){
    if(isTrump(c,t)){
      const st = trumpStrength(c,t);
      if(st===n) v+=1.0;
      else if(st===n-1) v+=.92;
      else if(st===n-2) v+=.80;
      else if(st===n-3) v+=.62;
      else if(st===n-4) v+=.48;
      else if(st===n-5) v+=.34;
      else v += .10 + .18*(st/n);
    } else {
      if(c.r==='K') v+=.32;
      else if(c.r==='Q') v+=.13;
      else if(c.r==='J') v+=.06;
      else if(c.r==='A' && c.s!=='D') v+=.05;
    }
  }
  return v;
}
function bestSuit(hand){
  let best = {suit:'S', v:-1};
  for(const s of SUITS){ const v = evalSuit(hand,s); if(v>best.v) best = {suit:s, v}; }
  return best;
}
const botTrump = hand => bestBidSuit(hand).suit;

/* What the hand actually holds in a given trump suit. */
function suitHolding(hand, t){
  const ids = new Set(hand.filter(c => isTrump(c,t)).map(c => c.id));
  return {
    n: ids.size,
    len: ids.size - (t!=='H' && ids.has('AH') ? 1 : 0),   // trumps actually in the suit
    five: ids.has('5'+t),
    jack: ids.has('J'+t),
    ah:   ids.has('AH'),
    ace:  t!=='H' && ids.has('A'+t),
    king: ids.has('K'+t)
  };
}

/* The ladder, by what's in the hand rather than a fuzzy score.
   A 5 is worth 15 on its own. Nothing above 15 without the 5 AND the jack. */
function bidFor(h){
  const honours = (h.ah?1:0) + (h.ace?1:0) + (h.king?1:0);
  // Thresholds swept over 500,000 deals, every holding played at every bid
  // level on identical cards. Bidding up is worth more than it looks because
  // it buys the contract and the right to name trump.
  if(h.five && h.jack && h.len>=5) return 30;                 // all five cards trump
  if(h.five && h.jack && h.len>=3 && honours>=2) return 25;
  if(h.five && (h.len>=3 || h.jack || (h.ah && h.len>=2))) return 20;
  if(h.five) return 15;                                       // the 5 alone is always worth 15

  // Never above 15 without the 5. An opponent holding it takes a trick AND the
  // high-trump unit, leaving you 4 of the remaining 4 — measured at 16%.
  // The ace of hearts is trump in every suit, so it is worth more defending
  // than bidding and never qualifies a bid on its own.
  if(h.jack && h.len>=3) return 15;
  if(h.jack && h.len>=2 && (h.ace||h.king)) return 15;
  if(h.len>=4 && (h.ace||h.king)) return 15;
  return 0;                                                   // raw length is not a bid
}

/* Best suit to call, and what it's worth. Ties break on length, then raw strength. */
function bestBidSuit(hand){
  let best = {suit:'S', bid:0, n:-1, v:-1};
  for(const s of SUITS){
    const h = suitHolding(hand, s);
    const bid = bidFor(h), v = evalSuit(hand, s);
    if(bid > best.bid || (bid===best.bid && (h.n > best.n || (h.n===best.n && v > best.v))))
      best = {suit:s, bid, n:h.n, v};
  }
  return best;
}

function botBid(hand, {highBid, seat, isDealer, dealerHold}){
  const want = bestBidSuit(hand).bid;
  const cur = highBid ? highBid.value : 0;
  const partnerIn = highBid && (highBid.seat % 2) === (seat % 2);
  if(partnerIn && want <= cur) return {value:null, hold:false};          // don't bid your partner up
  if(want > cur) return {value:want, hold:false};
  if(dealerHold && isDealer && highBid && cur<30 && want>=cur)
    return {value:cur, hold:true};
  return {value:null, hold:false};
}

// Nothing outside the trump suit is worth keeping — throw it all and draw fresh.
const botDiscard = (hand, t) => hand.filter(c => !isTrump(c,t)).map(c => c.id);

const hiFirst = (a,t) => a.slice().sort((x,y) => power(y,t)-power(x,t));

function botLead(legal, t, {onContract, trickNo, thirdHigh, teamKept, oppKept}){
  const n = TRUMP_ORDER[t].length;
  const trumps = hiFirst(legal.filter(c => isTrump(c,t)), t);
  const plains = hiFirst(legal.filter(c => !isTrump(c,t)), t);
  // Everyone pitches all their non-trump, so what a player KEEPS is exactly how
  // many trumps they were dealt — it is public information. When the other side
  // kept more than yours, stop pulling: make them spend trumps on plain tricks.
  const outgunned = teamKept!=null && oppKept!=null && oppKept > teamKept;

  // Opening lead off the contract: go low and let third man go high.
  if(trickNo===0 && !onContract && plains.length && thirdHigh!=='never')
    return plains[plains.length-1];
  if(trumps.length && trumpStrength(trumps[0],t) >= n-1) return trumps[0];  // 5 or J always pulls
  if(outgunned && plains.length) return plains[0].r==='K' ? plains[0] : plains[plains.length-1];
  if(plains.length && plains[0].r==='K') return plains[0];
  if(onContract && trumps.length) return trumps[0];
  if(plains.length) return plains[plains.length-1];
  return trumps[trumps.length-1];
}

function botPlay(hand, trick, t, ctx){
  const legal = legalMoves(hand, trick, t, ctx.enforce);
  const n = TRUMP_ORDER[t].length, top3 = TOP3(t);
  const toss = a => {
    const plain = a.filter(c => !isTrump(c,t));
    return hiFirst(plain.length ? plain : a, t).pop();
  };
  if(!trick.length) return botLead(legal, t, ctx);

  const ledSuit = effSuit(trick[0].card, t);
  const win = trickWinner(trick, t);
  const partnerAhead = (win.seat % 2) === (ctx.seat % 2);
  const seatOrder = trick.length;                      // 1 = second to play, 3 = last
  const beats = legal.filter(c => power(c,t) > power(win.card,t) && (isTrump(c,t) || effSuit(c,t)===ledSuit));

  if(partnerAhead){
    const solid = isTrump(win.card,t) ? trumpStrength(win.card,t) >= n-3 : seatOrder===3;
    if(solid || !beats.length) return toss(legal);
  }
  if(!beats.length) return toss(legal);

  // Third man high — a read, not a reflex: only off a low opening lead from a
  // partner who didn't buy the hand.
  if(seatOrder===2 && !partnerAhead && ctx.thirdHigh!=='never'){
    const lead = trick[0].card;
    const partnerBid = ctx.highBid && ctx.highBid.seat === trick[0].seat;
    const probe = ctx.trickNo===0 && !partnerBid && !isTrump(lead,t) && plainStrength(lead)<=6;
    if(ctx.thirdHigh==='always' ? ctx.trickNo===0 : probe) return hiFirst(beats,t)[0];
  }
  // Win as cheaply as you can, holding the 5, the jack and the ace of hearts
  // back while something smaller still does the job.
  const cheapest = hiFirst(beats,t).reverse();
  const modest = cheapest.filter(c => !top3.includes(c.id));
  return (modest.length ? modest : cheapest)[0];
}

module.exports = {
  SUITS, GLYPH, SUITNAME, RED, RANKS, TRUMP_ORDER, PLAIN_ORDER, TOP3,
  fullDeck, shuffle, isTrump, trumpStrength, plainStrength, effSuit, power,
  quotaFor, sortForDisplay, legalMoves, trickWinner,
  evalSuit, bestSuit, suitHolding, bidFor, bestBidSuit, botBid, botTrump, botDiscard, botPlay
};
