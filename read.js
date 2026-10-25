'use strict';
/* What the draw counts tell you. Everyone pitches all non-trump, so the number
   a player KEEPS is exactly how many trumps they were dealt. */
const R = require('./game');
const {deal} = require('./sim');
const team = s => s%2;

function hand(dealt, dealer){
  const hands = dealt.hands.map(h=>h.slice()), stock = dealt.stock.slice();
  let hb=null;
  for(let k=0;k<4;k++){ const s=(dealer+1+k)%4;
    const b=R.botBid(hands[s],{highBid:hb,seat:s,isDealer:s===dealer,dealerHold:true});
    if(b.value!==null && (b.hold || b.value>(hb?hb.value:0))) hb={value:b.value,seat:s};
    if(b.value===30) break; }
  if(!hb) hb={value:15,seat:dealer};
  const trump=R.botTrump(hands[hb.seat]);
  if(hb.value===30) return null;                 // no draw to read
  const kept=[0,0,0,0], finalTrumps=[0,0,0,0];
  for(let k=0;k<4;k++){ const s=(dealer+1+k)%4;
    hands[s]=hands[s].filter(c=>R.isTrump(c,trump));
    kept[s]=hands[s].length;
    while(hands[s].length<5&&stock.length) hands[s].push(stock.pop());
    finalTrumps[s]=hands[s].filter(c=>R.isTrump(c,trump)).length; }

  let trick=[],leader=hb.seat,units=[0,0],ht=null,tricks=[0,0,0,0];
  for(let t=0;t<5;t++){ trick=[];
    for(let i=0;i<4;i++){ const s=(leader+i)%4;
      const c=R.botPlay(hands[s],trick,trump,{seat:s,trickNo:t,highBid:hb,enforce:true,
        thirdHigh:'probe',onContract:team(hb.seat)===team(s)});
      hands[s]=hands[s].filter(x=>x.id!==c.id); trick.push({seat:s,card:c});
      if(R.isTrump(c,trump)&&(!ht||R.trumpStrength(c,trump)>R.trumpStrength(ht.card,trump))) ht={card:c,seat:s}; }
    const w=R.trickWinner(trick,trump); units[team(w.seat)]++; tricks[w.seat]++; leader=w.seat; }
  if(ht) units[team(ht.seat)]++;
  return {kept, finalTrumps, tricks, units, highSeat: ht?ht.seat:-1, bidder:hb.seat, bid:hb.value, trump};
}
module.exports = {hand, deal};
