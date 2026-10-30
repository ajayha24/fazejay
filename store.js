'use strict';
/* Where profiles and stats live.

   Three places, in order of preference:

     GITHUB_TOKEN  a private gist on your own GitHub account. Nothing new to
                   sign up for and nothing that expires. The gist is found by
                   its description, so there is no id to configure.
     DATABASE_URL  a Postgres table.
     neither       two JSON files next to the server, which is fine locally
                   but is wiped by hosts that clear their disk on deploy.

   If the chosen backend cannot be reached the game still runs on files and
   says why, rather than failing to start. */
const fs = require('fs');
const path = require('path');

const FILES = {
  profiles: path.join(__dirname, 'profiles.json'),
  stats:    path.join(__dirname, 'stats.json')
};

let pool = null;
let usingDb = false;
let gist = null;                  // {id, token} once found or created
const timers = {};

// Keep this string as it is: the gist is found by it, so changing the name
// would orphan everything already saved.
const GIST_MARK = 'kitchen-table-45s data — do not delete';
const GIST_FILES = {profiles:'profiles.json', stats:'stats.json'};

async function gh(pathname, init){
  const r = await fetch('https://api.github.com' + pathname, Object.assign({
    headers: {
      'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'kitchen-table-45s'
    }
  }, init || {}));
  if(!r.ok) throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0,120));
  return r.json();
}

/* Find our gist by description, or make it. Keeps the setup to one token. */
async function openGist(){
  const mine = await gh('/gists?per_page=100');
  const found = mine.find(g => g.description === GIST_MARK);
  if(found) return found.id;
  const made = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_MARK,
      public: false,
      files: {'profiles.json': {content: '{}'}, 'stats.json': {content: '{}'}}
    })
  });
  console.log('[store] created a private gist to hold the data');
  return made.id;
}

async function readGist(id){
  const g = await gh('/gists/' + id);
  const out = {profiles:{}, stats:{}, present:new Set()};
  for(const key of ['profiles','stats']){
    const f = g.files && g.files[GIST_FILES[key]];
    if(!f) continue;
    // A big file comes back truncated, with a raw_url to fetch instead.
    let text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    try { out[key] = JSON.parse(text || '{}'); out.present.add(key); } catch {}
  }
  return out;
}

function readFile(key){
  try { return JSON.parse(fs.readFileSync(FILES[key], 'utf8')); } catch { return {}; }
}
function writeFile(key, value){
  fs.writeFile(FILES[key], JSON.stringify(value), e => {
    if(e) console.error('[store] could not write ' + key + ':', e.message);
  });
}

async function init(){
  if(process.env.GITHUB_TOKEN){
    try {
      const id = await openGist();
      const got = await readGist(id);
      gist = {id};
      const out = {profiles:got.profiles, stats:got.stats};
      // First run against an empty gist: carry the files over, once.
      for(const key of ['profiles','stats']){
        if(got.present.has(key) && Object.keys(out[key]).length) continue;
        const fromFile = readFile(key);
        if(Object.keys(fromFile).length){
          out[key] = fromFile;
          await save(key, fromFile);
          console.log('[store] carried ' + key + ' over from the file into the gist');
        }
      }
      console.log('[store] profiles and stats are in a private gist');
      return out;
    } catch(e){
      console.error('[store] gist unavailable (' + e.message + ') — falling back');
      gist = null;
    }
  }

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
    if(gist){
      return gh('/gists/' + gist.id, {
        method: 'PATCH',
        body: JSON.stringify({files: {[GIST_FILES[key]]: {content: JSON.stringify(value)}}})
      }).catch(e => console.error('[store] could not save ' + key + ':', e.message));
    }
    if(!usingDb || !pool){ writeFile(key, value); return Promise.resolve(); }
    return pool.query(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    ).catch(e => console.error('[store] could not save ' + key + ':', e.message));
  }
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => save(key, value), gist ? Math.max(wait, 4000) : wait);
}

const isDb = () => usingDb || !!gist;
const backend = () => gist ? 'gist' : usingDb ? 'postgres' : 'files';
module.exports = {init, save, isDb, backend};
