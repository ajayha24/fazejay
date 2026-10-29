'use strict';
/* Where profiles and stats live.

   With DATABASE_URL set, a Postgres table holds them, so they survive the host
   wiping its disk on every deploy. Without it, two JSON files next to the
   server do the same job locally. If a database is configured but cannot be
   reached, the game still runs on files and says so rather than failing. */
const fs = require('fs');
const path = require('path');

const FILES = {
  profiles: path.join(__dirname, 'profiles.json'),
  stats:    path.join(__dirname, 'stats.json')
};

let pool = null;
let usingDb = false;
const timers = {};

function readFile(key){
  try { return JSON.parse(fs.readFileSync(FILES[key], 'utf8')); } catch { return {}; }
}
function writeFile(key, value){
  fs.writeFile(FILES[key], JSON.stringify(value), e => {
    if(e) console.error('[store] could not write ' + key + ':', e.message);
  });
}

async function init(){
  const url = process.env.DATABASE_URL;
  if(!url){
    console.log('[store] no DATABASE_URL — profiles and stats are kept in files');
    return {profiles: readFile('profiles'), stats: readFile('stats')};
  }
  try {
    const {Pool} = require('pg');
    pool = new Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : {rejectUnauthorized: false},
      max: 4,
      connectionTimeoutMillis: 8000
    });
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL)');
    const {rows} = await pool.query("SELECT key, value FROM kv WHERE key IN ('profiles','stats')");
    const out = {profiles:{}, stats:{}};
    const present = new Set();
    for(const r of rows){ out[r.key] = r.value || {}; present.add(r.key); }
    usingDb = true;        // must be set before any save(), or writes go to the file

    // Only on the very first run against a database — once a row exists it is
    // the truth, so a leftover file can never overwrite newer data.
    for(const key of ['profiles','stats']){
      if(present.has(key)) continue;
      const fromFile = readFile(key);
      if(Object.keys(fromFile).length){
        out[key] = fromFile;
        await save(key, fromFile);
        console.log('[store] carried ' + key + ' over from the file into the database');
      }
    }
    console.log('[store] profiles and stats are in Postgres');
    return out;
  } catch(e){
    console.error('[store] database unavailable (' + e.message + ') — falling back to files');
    pool = null;
    return {profiles: readFile('profiles'), stats: readFile('stats')};
  }
}

/* Writes are debounced: a busy hand can touch stats several times a second. */
function save(key, value, wait){
  if(!wait){
    if(!usingDb || !pool){ writeFile(key, value); return Promise.resolve(); }
    return pool.query(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    ).catch(e => console.error('[store] could not save ' + key + ':', e.message));
  }
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => save(key, value), wait);
}

const isDb = () => usingDb;
module.exports = {init, save, isDb};
