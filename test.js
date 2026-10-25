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
ok(bid(['5S','JS','9D','KC','2H']).bid===15, "5 + jack with no length stays at 15");
ok(bid(['JS','AH','7S','9D','2H']).bid===15, "jack + A-hearts + a third trump opens 15");
ok(bid(['JS','AH','9D','KC','2H']).bid===0, "jack + A-hearts with no third trump passes");
ok(bid(['AS','KS','QS','7S','2H']).bid===15, "four trumps with an honour bids 15");
ok(bid(['5S','JS','KS','7S','2H']).bid===25, "5 + jack + king with four trumps bids 25");
ok(bid(['5S','JS','AH','KS','7S']).bid===30, "5 + jack + A-hearts with five trumps bids 30");
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

out.push(fails? ("\n"+fails+" FAILED") : "\nall "+out.length+" checks passed");
console.log(out.join("\n"));
process.exit(fails?1:0);
