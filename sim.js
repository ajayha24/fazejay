'use strict';
/* Headless 45s. Plays complete hands with the real engine so we can measure
   what a trump holding is actually worth, and whether bidding beats passing. */
const R = require('./game');

const S = { target:31, defendersScore:true, setPenalty:'quota',
            enforceRenege:true, dealerHold:true, draw:'everyone', thirdHigh:'probe' };
const team = s => s % 2;

function deal(){
  const d = R.shuffle(R.fullDeck());
  const hands = [[],[],[],[]];
  for(const chunk of [3,2]) for(let k=0;k<4;k++){
    for(let n=0;n<chunk;n++) hands[k].push(d.pop());
  }
  return {hands, stock:d};
}

/* override: null (all bots) | {seat, bid, suit} forcing one seat's auction choice.
   bid 0 means "that seat passes". */
function playHand(dealt, dealer, override){
  const hands = dealt.hands.map(h => h.slice());
  const stock = dealt.stock.slice();
  let highBid = null;

  for(let k=0;k<4;k++){
    const seat = (dealer+1+k)%4;
    let v, hold=false;
    if(override && override.seat===seat){
      v = override.bid || null;
      if(v && highBid && v<=highBid.value) v = null;        // can't underbid
    } else {
      const b = R.botBid(hands[seat], {highBid, seat, isDealer:seat===dealer, dealerHold:S.dealerHold});
      v = b.value; hold = b.hold;
    }
    if(v!==null){
      if(hold || v > (highBid?highBid.value:0)) highBid = {value:v, seat};
      if(v===30) break;
    }
  }
  if(!highBid) highBid = {value:15, seat:dealer, stuck:true};

  const trump = (override && override.seat===highBid.seat && override.suit)
    ? override.suit : R.botTrump(hands[highBid.seat]);

  // everyone throws what isn't trump and draws back to five
  if(highBid.value !== 30){
    for(let k=0;k<4;k++){
      const seat = (dealer+1+k)%4;
      hands[seat] = hands[seat].filter(c => R.isTrump(c, trump));
      while(hands[seat].length<5 && stock.length) hands[seat].push(stock.pop());
    }
  }

  let trick=[], leader=highBid.seat, units=[0,0], highTrump=null;
  for(let t=0;t<5;t++){
    trick = [];
    for(let i=0;i<4;i++){
      const seat = (leader+i)%4;
      const card = R.botPlay(hands[seat], trick, trump, {
        seat, trickNo:t, highBid, enforce:S.enforceRenege, thirdHigh:S.thirdHigh,
        onContract: team(highBid.seat)===team(seat)
      });
      hands[seat] = hands[seat].filter(c => c.id!==card.id);
      trick.push({seat, card});
      if(R.isTrump(card,trump) && (!highTrump || R.trumpStrength(card,trump) > R.trumpStrength(highTrump.card,trump)))
        highTrump = {card, seat};
    }
    const w = R.trickWinner(trick, trump);
    units[team(w.seat)]++;
    leader = w.seat;
  }
  if(highTrump) units[team(highTrump.seat)]++;

  const bt = team(highBid.seat), dt = 1-bt;
  const quota = R.quotaFor(highBid.value);
  const made = units[bt] >= quota;
  const deltas = [0,0];
  deltas[bt] = made ? (units[bt]===6 ? 9 : units[bt]) : -quota;
  deltas[dt] = units[dt];
  return {bid:highBid.value, bidderSeat:highBid.seat, trump, units, deltas, made, quota};
}

/* ---- how a holding is described ---- */
function sig(hand, t){
  const h = R.suitHolding(hand, t);
  const tags = [];
  if(h.five) tags.push('5');
  if(h.jack) tags.push('J');
  if(h.ah)   tags.push('A♥');
  if(h.ace)  tags.push('A');
  if(h.king) tags.push('K');
  const named = tags.length;
  const plain = h.n - named;
  return {key: (tags.join('+')||'none') + (plain?' +'+plain:'') + ' ('+h.n+')', n:h.n, h};
}

module.exports = {deal, playHand, sig, team, S};
