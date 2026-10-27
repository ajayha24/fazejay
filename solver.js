'use strict';
/* Exact analysis of a 45s hand. Once play begins all four hands are known, so
   with only five tricks the whole game tree can be searched outright. Used for
   the post-hand review: what the best line was worth, and what each choice
   actually cost. */
const R = require('./game');
const team = s => s % 2;

/* Cards that sit next to each other in what is left of a suit, and are all in
   the same hand, play identically — searching each of them separately is what
   makes an unreduced solver blow up. Keep the lowest of every such run. */
function reduceMoves(legal, hands, trump){
  if(legal.length < 2) return legal;
  const bySuit = {};
  for(const h of hands) for(const c of h){
    const es = R.effSuit(c, trump);
    (bySuit[es] = bySuit[es] || []).push(c);
  }
  for(const k in bySuit) bySuit[k].sort((a,b) => R.power(b,trump) - R.power(a,trump));
  const ok = new Set(legal.map(c => c.id));
  const keep = [];
  for(const k in bySuit){
    const arr = bySuit[k];
    let run = null;
    for(let i=0;i<=arr.length;i++){
      const inRun = i < arr.length && ok.has(arr[i].id);
      if(inRun){ run = arr[i]; }            // lowest so far in this run
      else if(run){ keep.push(run); run = null; }
    }
  }
  return keep.length ? keep : legal;
}

/* Units for team 0 with best play by both sides from this position.
   `best` is the strongest trump played so far: {strength, team} or null.
   Alpha-beta, so only values that were searched in full get remembered. */
function solve(hands, trump, leader, trick, best, enforce, memo, budget, alpha, beta){
  if(hands.every(h => h.length === 0)) return (best && best.team === 0 ? 1 : 0);

  const key = hands.map(h => h.map(c => c.id).sort().join('.')).join('|')
            + '#' + trick.map(p => p.seat + ':' + p.card.id).join('.')
            + '#' + leader + '#' + (best ? best.strength + ',' + best.team : '-');
  if(memo.has(key)) return memo.get(key);
  if(budget.n++ > budget.cap) return null;              // refuse to run away

  const seat = trick.length ? (trick[trick.length-1].seat + 1) % 4 : leader;
  const mine = team(seat) === 0;
  const legal = reduceMoves(R.legalMoves(hands[seat], trick, trump, enforce), hands, trump);

  let bestVal = mine ? -1 : 7, cut = false;
  for(const card of legal){
    const nh = hands.map((h,i) => i===seat ? h.filter(c => c.id!==card.id) : h);
    let nb = best;
    if(R.isTrump(card, trump)){
      const st = R.trumpStrength(card, trump);
      if(!best || st > best.strength) nb = {strength:st, team:team(seat)};
    }
    const nt = trick.concat([{seat, card}]);
    let val;
    if(nt.length === 4){
      const w = R.trickWinner(nt, trump);
      const won = team(w.seat) === 0 ? 1 : 0;
      const sub = solve(nh, trump, w.seat, [], nb, enforce, memo, budget, alpha - won, beta - won);
      if(sub === null) return null;
      val = sub + won;
    } else {
      val = solve(nh, trump, leader, nt, nb, enforce, memo, budget, alpha, beta);
      if(val === null) return null;
    }
    if(mine){
      if(val > bestVal) bestVal = val;
      if(bestVal > alpha) alpha = bestVal;
    } else {
      if(val < bestVal) bestVal = val;
      if(bestVal < beta) beta = bestVal;
    }
    if(alpha >= beta){ cut = true; break; }
  }
  if(!cut) memo.set(key, bestVal);
  return bestVal;
}

/* Value of a position for the given team. */
function valueFor(hands, trump, leader, trick, best, enforce, side){
  const memo = new Map(), budget = {n:0, cap:900000};
  const v = solve(hands.map(h=>h.slice()), trump, leader, trick, best, enforce, memo, budget, -1, 7);
  if(v === null) return null;
  return side === 0 ? v : 6 - v;
}

/* Replay a finished hand and score every choice the given seat made.
   `start` are the four hands as play began; `plays` is every card in order. */
function reviewHand({start, plays, trump, leader, seat, enforce=true}){
  const hands = start.map(h => h.slice());
  const side = team(seat);
  let trick = [], lead = leader, best = null, trickNo = 0;
  const notes = [];

  const par = valueFor(hands, trump, lead, [], null, enforce, side);
  let running = par;

  for(const mv of plays){
    const isMine = mv.seat === seat;
    const legal = R.legalMoves(hands[mv.seat], trick, trump, enforce);

    let alts = null;
    if(isMine && legal.length > 1){
      alts = [];
      for(const card of legal){
        const nh = hands.map((h,i) => i===mv.seat ? h.filter(c=>c.id!==card.id) : h);
        let nb = best;
        if(R.isTrump(card, trump)){
          const st = R.trumpStrength(card, trump);
          if(!best || st > best.strength) nb = {strength:st, team:team(mv.seat)};
        }
        const nt = trick.concat([{seat:mv.seat, card}]);
        let v;
        if(nt.length === 4){
          const w = R.trickWinner(nt, trump);
          const sub = valueFor(nh, trump, w.seat, [], nb, enforce, side);
          v = sub === null ? null : sub + (team(w.seat) === side ? 1 : 0);
        } else {
          v = valueFor(nh, trump, lead, nt, nb, enforce, side);
        }
        if(v !== null) alts.push({card, value:v});
      }
    }

    // apply the move
    hands[mv.seat] = hands[mv.seat].filter(c => c.id !== mv.card.id);
    if(R.isTrump(mv.card, trump)){
      const st = R.trumpStrength(mv.card, trump);
      if(!best || st > best.strength) best = {strength:st, team:team(mv.seat)};
    }
    trick.push({seat:mv.seat, card:mv.card});

    if(alts && alts.length){
      const played = alts.find(a => a.card.id === mv.card.id);
      const top = alts.reduce((a,b) => b.value > a.value ? b : a);
      if(played && top.value > played.value){
        notes.push({
          trickNo: trickNo + 1,
          card: mv.card,
          cost: top.value - played.value,
          better: alts.filter(a => a.value === top.value).map(a => a.card),
          lead: trick.length === 1,
          wasWinning: trick.length > 1 &&
            team(R.trickWinner(trick, trump).seat) === side
        });
      }
    }

    if(trick.length === 4){
      const w = R.trickWinner(trick, trump);
      lead = w.seat; trick = []; trickNo++;
    }
  }
  return {par, notes};
}

module.exports = {solve, valueFor, reviewHand};
