'use strict';
/* A player that plays itself, for shaking the server out.

     node botclient.js                     one table locally
     WS=wss://host node botclient.js       against a deployed server

   It reports stalls: twelve seconds with nothing changing means a beat was
   lost somewhere, which is how every freeze in this game has been found. */
const WebSocket = require('./node_modules/ws');
const ws = new WebSocket(process.env.WS || 'ws://localhost:3000');
const NAME = process.env.NAME || 'Robo';
let V = null, hands = 0, stalls = 0, lastSig = '', lastChange = Date.now(), reacted = false;
const send = o => ws.send(JSON.stringify(o));

ws.on('open', () => {
  send({type:'newprofile', name:NAME, avatar:'🤖', password:'botpw123'});
  setTimeout(() => send({type:'create', name:NAME, password:'botpw123'}), 250);
});
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if(m.type === 'error'){ console.log('SERVER ERROR:', m.message); return; }
  if(m.type !== 'state') return;
  V = m.view;
  const sig = [V.phase, V.handNo, V.trickNo, V.turn, (V.ready||[]).join(''),
               V.iAmReady, (V.hand||[]).length].join('/');
  if(sig !== lastSig){ lastSig = sig; lastChange = Date.now(); }
  act();
});

function act(){
  if(!V) return;
  if(!reacted && V.phase === 'playing'){ reacted = true; send({type:'react', emoji:'😄'}); }
  if(V.phase === 'lobby') return setTimeout(() => send({type:'start'}), 200);
  if(V.phase === 'bidding' && V.turn === V.mySeat){
    const cur = V.highBid ? V.highBid.value : 0;
    const up = [15,20,25,30].filter(b => b > cur);
    return send(up.length && Math.random() < 0.5 ? {type:'bid', value:up[0]} : {type:'bid', value:null});
  }
  if(V.phase === 'naming' && V.highBid.seat === V.mySeat)
    return send({type:'trump', suit:['S','H','D','C'][Math.floor(Math.random()*4)]});
  if(V.phase === 'drawing' && V.drawers && V.drawers.includes(V.mySeat) && !V.iAmReady){
    let ids = V.hand.filter(() => Math.random() < 0.5).map(c => c.id);
    if(V.hand.length - ids.length > 5) ids = V.hand.slice(0, V.hand.length-5).map(c => c.id);
    return send({type:'discard', ids});
  }
  if(V.mustPlay) return send({type:'contribute', ids:V.hand.slice(0, V.mustPlay.count).map(c => c.id)});
  if(V.phase === 'playing' && V.turn === V.mySeat){
    if(V.canDeclare) return send({type:'declare', count:V.canDeclare});
    if(V.legal && V.legal.length)
      return send({type:'play', cardId:V.legal[Math.floor(Math.random()*V.legal.length)]});
  }
  if(V.phase === 'handover'){ hands++; return setTimeout(() => send({type:'next'}), 120); }
  if(V.phase === 'gameover'){ hands++; return setTimeout(() => send({type:'newgame'}), 120); }
}

setInterval(() => {
  if(V && Date.now() - lastChange > 12000){
    stalls++; console.log('STALL ' + lastSig); lastChange = Date.now();
  }
}, 3000);
setTimeout(() => {
  console.log('played ' + hands + ' hands, ' + stalls + ' stalls');
  process.exit(stalls ? 1 : 0);
}, Number(process.env.RUN_MS) || 110000);
