'use strict';
/* Rule checks for the 45s engine.  Run with:  node test.js  */
var out=[], fails=0;
function ok(c,m){ if(!c){fails++; out.push("FAIL "+m);} else out.push("ok   "+m); }

var R = require('./game');

var C=function(id){ var r=id.slice(0,-1), s=id.slice(-1); return {r:r,s:s,id:id}; };
var T=function(arr){ return arr.map(function(x,i){ return {seat:i, card:C(x)}; }); };

// --- trump ranking ---
ok(R.trumpStrength(C('5S'),'S') > R.trumpStrength(C('JS'),'S'), "5 of trump beats the jack");
ok(R.trumpStrength(C('JS'),'S') > R.trumpStrength(C('AH'),'S'), "jack beats ace of hearts");
ok(R.trumpStrength(C('AH'),'S') > R.trumpStrength(C('AS'),'S'), "A-hearts is third, above the trump ace");
ok(R.isTrump(C('AH'),'S'), "A-hearts is trump when spades are trump");
ok(R.trumpStrength(C('2S'),'S') > R.trumpStrength(C('10S'),'S'), "black trump: low beats high");
ok(R.trumpStrength(C('10D'),'D') > R.trumpStrength(C('2D'),'D'), "red trump: high beats low");

// --- plain ranking ---
ok(R.plainStrength(C('KC')) > R.plainStrength(C('AC')), "plain black: king beats ace");
ok(R.plainStrength(C('2C')) > R.plainStrength(C('10C')), "plain black: 2 beats 10");
ok(R.plainStrength(C('2D')) > R.plainStrength(C('AD')), "plain diamonds: ace is lowest");

// --- trick winner: the bug we fixed ---
var w = R.trickWinner(T(['KC','4S','QC','3C']),'S');   // clubs led, seat1 trumps with 4S
ok(w.seat===1, "a trump takes a trick led with a plain suit");
w = R.trickWinner(T(['KC','4S','5S','3C']),'S');
ok(w.seat===2, "the higher trump wins when two players trump in");
w = R.trickWinner(T(['KC','QC','AC','3C']),'S');
ok(w.seat===0, "no trump played: high card of the led suit takes it");
w = R.trickWinner(T(['9H','AH','KH','2H']),'S');
ok(w.seat===1, "A-hearts beats plain hearts when spades are trump");

// --- following suit ---
var hand=[C('KC'),C('3C'),C('4S'),C('9D')];
var legal=R.legalMoves(hand, T(['QC']), 'S', true).map(function(c){return c.id;});
ok(legal.indexOf('KC')>=0 && legal.indexOf('4S')>=0 && legal.indexOf('9D')<0,
   "plain lead: may follow or trump, may not throw off");
hand=[C('9D'),C('2D')];
legal=R.legalMoves(hand, T(['QC']), 'S', true).map(function(c){return c.id;});
ok(legal.length===2, "void in the led suit and no trump: anything goes");

// renege
hand=[C('5S'),C('9D')];
legal=R.legalMoves(hand, T(['KS']), 'S', true).map(function(c){return c.id;});
ok(legal.indexOf('9D')>=0, "may renege the 5 when it is your only trump");
hand=[C('5S'),C('7S'),C('9D')];
legal=R.legalMoves(hand, T(['KS']), 'S', true).map(function(c){return c.id;});
ok(legal.indexOf('9D')<0 && legal.length===2, "holding another trump, you must follow");
hand=[C('AH'),C('JS'),C('9D')];
legal=R.legalMoves(hand, T(['KS']), 'S', true).map(function(c){return c.id;});
ok(legal.indexOf('9D')>=0, "two top trumps and nothing else: still renegable");

// --- quotas ---
ok(R.quotaFor(15)===3 && R.quotaFor(20)===4 && R.quotaFor(25)===5 && R.quotaFor(30)===6, "bid quotas");

// --- deal integrity ---
var d=R.shuffle(R.fullDeck());
ok(d.length===52, "52 cards");
var seen={}; d.forEach(function(c){seen[c.id]=1;});
ok(Object.keys(seen).length===52, "no duplicate cards");
var tc=d.filter(function(c){return R.isTrump(c,'S');}).length;
ok(tc===14, "14 trumps in a black suit");
ok(d.filter(function(c){return R.isTrump(c,'H');}).length===13, "13 trumps when hearts are trump");

// --- bots return a legal card ---
var t='S', bhand=[C('KC'),C('3C'),C('4S'),C('9D'),C('2H')];
var pick=R.botPlay(bhand, T(['QC']), t, {seat:1,trickNo:0,highBid:{seat:0,value:20},enforce:true,thirdHigh:'probe',onContract:false});
var lg=R.legalMoves(bhand, T(['QC']), t, true).map(function(c){return c.id;});
ok(lg.indexOf(pick.id)>=0, "bot follow play is legal");
pick=R.botPlay(bhand, [], t, {seat:1,trickNo:0,highBid:{seat:0,value:20},enforce:true,thirdHigh:'probe',onContract:false});
ok(bhand.some(function(c){return c.id===pick.id;}), "bot lead is a card it holds");

// bot keeps trumps and kings on the draw
var disc=R.botDiscard([C('5S'),C('KC'),C('9D'),C('2H'),C('AH')],'S');
ok(disc.length===3 && disc.indexOf('KC')>=0, "bot throws off-suit kings too — only trumps are worth keeping");


/* ---- bidding ladder and discards ---- */
var H=function(ids){ return ids.map(C); };
var bid=function(ids){ return R.bestBidSuit(H(ids)); };

ok(bid(['5S','3S','9D','KC','2H']).bid===15, "a 5 on its own bids 15");
ok(bid(['5S','3S','9D','KC','2H']).suit==='S', "and calls the suit the 5 is in");
ok(bid(['5S','JS','7S','9D','2H']).bid===20, "5 + jack + a third trump bids 20");
ok(bid(['5S','JS','9D','KC','2H']).bid===20, "5 + jack is worth 20 even with no length");
// The ace of hearts is trump in every suit, so it never counts as length and
// never qualifies a bid on its own — it is worth more defending.
ok(bid(['JS','AH','7S','9D','2H']).bid===0, "jack + A-hearts + one spade is a pass, not a bid");
ok(bid(['JS','AH','7S','3S','2H']).bid===15, "jack with three real spades does open 15");
ok(bid(['AH','7S','3S','9D','2H']).bid===0, "A-hearts alone never bids");
ok(bid(['AH','KS','QS','9S','2H']).bid===0, "A-hearts plus only three real spades is still a pass");
ok(bid(['KS','QS','9S','7S','2H']).bid===15, "four real spades with the king does open 15");
ok(R.suitHolding([C('AH'),C('9S')],'S').len===1, "A-hearts is not counted as length in another suit");
ok(R.suitHolding([C('AH'),C('9H')],'H').len===2, "it is length when hearts are trump");
ok(bid(['5S','3S','2S','9S','7S']).bid===20, "the 5 plus length is 20 without needing the jack");
ok(bid(['5S','3S','9D','KC','2H']).bid===15, "the 5 plus one other trump stays at 15");
ok(bid(['5S','9D','KC','2H','7C']).bid===15, "the bare 5 stays at 15");
ok(bid(['AS','KS','QS','7S','2H']).bid===15, "four trumps with an honour bids 15");
ok(bid(['5S','JS','KS','7S','2H']).bid===20, "5 + jack + king with four trumps is 20 — 25 needs two honours");
ok(bid(['5S','JS','KS','AS','2H']).bid===25, "5 + jack + king + ace bids 25");
ok(bid(['5S','JS','AH','KS','7S']).bid===25, "5 + jack + A-hearts + king bids 25 (four real spades)");
ok(bid(['5S','JS','KS','7S','3S']).bid===30, "5 + jack with all five cards trump bids 30");
ok(bid(['KC','QD','9H','3S','2H']).bid===0, "a scattered hand passes");

// the 5 must beat a bare-length hand when both are available
var b=bid(['5D','3D','AS','KS','QS']);
ok(b.bid===15, "picks a biddable suit from a two-suited hand");

// no bid above 15 without the five
var noFive=[['JS','AH','KS','QS','7S'],['AS','KS','QS','JS','7S']];
ok(noFive.every(function(h){ return bid(h).bid<=15; }), "nothing outbids 15 without the 5");

// auction behaviour
var mk=function(ids,o){ return R.botBid(H(ids), o); };
ok(mk(['5S','3S','9D','KC','2H'],{highBid:null,seat:1,isDealer:false,dealerHold:true}).value===15,
   "bot opens 15 holding a 5");
ok(mk(['5S','3S','9D','KC','2H'],{highBid:{value:15,seat:0},seat:1,isDealer:false,dealerHold:true}).value===null,
   "a bare 5 cannot raise a standing 15");
ok(mk(['5S','JS','7S','9D','2H'],{highBid:{value:15,seat:0},seat:1,isDealer:false,dealerHold:true}).value===20,
   "5 + jack + length raises to 20");
var held=mk(['5S','3S','9D','KC','2H'],{highBid:{value:15,seat:0},seat:1,isDealer:true,dealerHold:true});
ok(held.value===15 && held.hold===true, "the dealer holds at 15 rather than raising");
ok(mk(['5S','3S','9D','KC','2H'],{highBid:{value:15,seat:3},seat:1,isDealer:false,dealerHold:true}).value===null,
   "never bids a partner up");

// discards
ok(R.botDiscard(H(['5S','KC','9D','2H','AH']),'S').sort().join()==='2H,9D,KC',
   "throws every card outside trump, keeping the ace of hearts");
ok(R.botDiscard(H(['5S','JS','7S','2S','AH']),'S').length===0, "an all-trump hand stands pat");


/* ---- reneging: only over a LOWER trump lead ---- */
var only=function(ids,led){ return R.legalMoves(H(ids), T([led]), 'S', true).map(function(c){return c.id;}); };
ok(only(['JS','9D'],'5S').indexOf('9D')<0, "the 5 led drags out a lone jack");
ok(only(['AH','9D'],'5S').indexOf('9D')<0, "the 5 led drags out a lone ace of hearts");
ok(only(['AH','9D'],'JS').indexOf('9D')<0, "the jack led drags out a lone ace of hearts");
ok(only(['5S','9D'],'JS').indexOf('9D')>=0, "but the 5 may still be held back under the jack");
ok(only(['5S','9D'],'KS').indexOf('9D')>=0, "and under any lower trump");
ok(only(['JS','9D'],'KS').indexOf('9D')>=0, "a lone jack may be held back under the king");
ok(only(['AH','9D'],'KS').indexOf('9D')>=0, "a lone ace of hearts may be held back under the king");
ok(only(['JS','7S','9D'],'KS').indexOf('9D')<0, "holding another trump you must follow regardless");
ok(only(['5S','JS','9D'],'KS').indexOf('9D')>=0, "two renegable tops and nothing else stays free");
ok(only(['5S','AH','9D'],'JS').indexOf('9D')<0, "the jack led forces the ace of hearts even beside the 5");


/* ---- never waste a trump on a trick your partner already holds ---- */
var ctx=function(seat){ return {seat:seat,trickNo:1,highBid:{seat:1,value:15},enforce:true,
                                thirdHigh:'probe',onContract:false,teamKept:3,oppKept:3}; };
// partner (seat 0) leads the king of clubs; you sit second with the ace of hearts
var pick=R.botPlay(H(['AH','9C','3C']), [{seat:0,card:C('KC')}], 'S', ctx(2));
ok(pick.id!=='AH', "does not trump partner's king of clubs with the ace of hearts");
ok(pick.s==='C', "follows suit with a club instead");
pick=R.botPlay(H(['AH','9D','3D']), [{seat:0,card:C('QC')}], 'S', ctx(2));
ok(pick.id!=='AH', "nor on partner's queen when void in the suit");
// an OPPONENT winning with the king is a different matter
pick=R.botPlay(H(['AH','9D','3D']), [{seat:1,card:C('KC')}], 'S', ctx(2));
ok(pick.id==='AH', "but does trump an opponent's king when it is the only winner");


/* ---- a declaration must not let anyone play twice ---- */
ok(R.validContribution(H(['7S','3S','9D']),'S',2,['7S','3S']), "two trumps: both go in");
ok(!R.validContribution(H(['7S','3S','9D']),'S',2,['7S','9D']), "cannot hold a trump back");
ok(R.validContribution(H(['7S','9D','KC']),'S',2,['7S','9D']), "one trump plus any card");
ok(!R.validContribution(H(['7S','9D','KC']),'S',2,['9D','KC']), "the single trump must go in");
ok(R.validContribution(H(['9D','KC','2H']),'S',2,['9D','KC']), "no trumps: any two");
ok(!R.validContribution(H(['9D','KC','2H']),'S',2,['9D']), "wrong count is refused");
ok(!R.validContribution(H(['9D','KC']),'S',2,['9D','9D']), "the same card twice is refused");
ok(R.validContribution(H(['9D']),'S',2,['9D']), "short of cards, you give what you have");


/* ---- reading the table: do not burn a top trump on a safe trick ---- */
(function(){
  var t='C';                                   // clubs are trump
  var hand=[C('AH'),C('9D'),C('2S')];          // A-hearts is my only trump
  // Partner (seat 2) led K-clubs; both opponents have shown out of trump.
  var trick=[{seat:2,card:C('KC')},{seat:3,card:C('4D')}];
  var ctx={seat:0,trickNo:2,highBid:{seat:2,value:15},enforce:true,thirdHigh:'probe',
           onContract:true,seen:new Set(['KC','4D','5C','JC']),voidTrump:{1:true,3:true},
           acted:[2,3],skill:'sharp'};   // reading the table is a sharp bot's trick
  var pick=R.botPlay(hand,trick,t,ctx);
  ok(pick.id!=='AH', "a sharp bot holds the ace of hearts back on a trick nobody can take");
  var easy=Object.assign({},ctx,{skill:'easy'});
  ok(R.opponentThreat(C('KC'),t,easy,hand)===true, "an easy bot does not count cards, so it assumes a threat");

  // Same trick, but the 5 of clubs is still out there and an opponent could hold it.
  var ctx2=Object.assign({},ctx,{seen:new Set(['KC','4D']),voidTrump:{}});
  ok(R.opponentThreat(C('KC'),t,ctx2,hand)===true, "an opponent who has not shown out is a threat");
  ok(R.opponentThreat(C('KC'),t,ctx,hand)===false, "once both have shown out and the tops are gone, none");

  // Shown out of trump, but the 5 has not appeared — it can still be reneged.
  var ctx3=Object.assign({},ctx,{seen:new Set(['KC','4D','JC']),voidTrump:{1:true,3:true}});
  ok(R.opponentThreat(C('KC'),t,ctx3,hand)===true, "a renegable 5 still counts as a threat");

  var out=R.outstandingAbove(C('KC'),'C',new Set(['5C']),[C('AH')]);
  ok(out.indexOf('5C')<0 && out.indexOf('AH')<0 && out.indexOf('JC')>=0 && out.indexOf('AC')>=0,
     "outstanding cards exclude what is seen and what I hold");
})();

out.push(fails? ("\n"+fails+" FAILED") : "\nall "+out.length+" checks passed");
console.log(out.join("\n"));
process.exit(fails?1:0);
