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
ok(disc.length===2 && disc.indexOf('9D')>=0 && disc.indexOf('2H')>=0, "bot discards only the junk");

out.push(fails? ("\n"+fails+" FAILED") : "\nall "+out.length+" checks passed");
console.log(out.join("\n"));
process.exit(fails?1:0);
