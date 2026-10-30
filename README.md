# 45

Auction 45s for four players, by our house rules. One person starts a table,
sends the link to three friends, and any empty seat is played by a bot.

The server deals and holds all four hands. Each browser is only ever sent its
own five cards, so nobody can read anyone else's hand out of the page.

## House rules

- Six units a hand: five tricks plus one for the highest trump played.
- Bids map to quotas — 15 = 3 of 6, 20 = 4, 25 = 5, 30 = all 6.
- Make the bid and you score the units you took; all six pays 9. Miss it and
  your team drops the bid's quota. The other side banks its own units either way.
- One round of bidding from the dealer's left. Only the dealer may take it at
  the standing number; everyone else has to raise. A 30 ends the auction.
- Passed all the way round and the dealer is stuck at 15.
- The bidder names trump, then everyone discards and draws back up to five —
  except on a 30, which is played exactly as dealt.
- Plain suit led: follow it or trump it. Trump led: you must follow, unless the
  5, the jack and the ace of hearts are your only trumps.
- First team to 31.

## Run it locally

Needs Node 18 or newer (this machine doesn't have it yet — install from
https://nodejs.org or `brew install node`).

```
npm install
npm start
```

Then open http://localhost:3000.

## Put it online (Render, free)

1. Push this folder to a new GitHub repo.
2. On https://render.com — **New → Web Service**, connect the repo.
3. Runtime **Node**, build `npm install`, start `npm start`, instance type **Free**.
4. Deploy. You get a URL like `https://kitchen-table-45s.onrender.com`.

Share that URL. Anyone who opens it can start a table or join one with a code —
no account needed. Free instances sleep after ~15 minutes idle and take about
30 seconds to wake on the next visit.

Fly.io and Railway work the same way: Node, `npm install`, `npm start`, one
web port from `process.env.PORT`.

## Keeping profiles and stats

By default they sit in `profiles.json` and `stats.json` next to the server.
That is fine locally, but a host that clears its disk between deploys — Render's
free tier does — loses them on every update. The lobby says so when that is the
case.

### A private gist (no extra service, nothing expires)

Uses the GitHub account you already have.

1. Go to https://github.com/settings/tokens → **Generate new token (classic)**.
2. Tick only the **gist** scope. Nothing else is needed, and this token cannot
   touch your repositories.
3. Copy the token.
4. On Render: the service's **Environment** tab → add `GITHUB_TOKEN` with that
   value → save.

On first run the server makes one private gist called
"kitchen-table-45s data — do not delete" and keeps both files in it. It finds
that gist by name afterwards, so there is no id to configure. Don't rename or
delete it.

### Or Postgres

Set `DATABASE_URL` to a connection string instead. Render's own free Postgres
expires after 30 days; Neon (https://neon.tech) and Supabase do not.

Either way, whatever is already in the JSON files is carried across once on the
first run, and after that the remote copy is the truth. If the backend cannot
be reached the game still runs on files and logs why.

## Guests

`Guest` is always in the list and needs no password. Nothing a guest does is
recorded — no books, no hands, no games. Several people can be guests at one
table; they are numbered Guest, Guest 2 and so on. The name is reserved, so it
cannot be created, reset or deleted.

## Forgotten passwords

Each profile sets a password when it is made. Only a salted scrypt hash is
stored, so a password cannot be read back by anyone — including whoever runs
the server. What you can do is clear one, after which that player sets a new
one themselves the next time they join.

Set a reset key on the server to enable it. On Render: the service's
**Environment** tab, add `ADMIN_KEY` with a value only you know, and save.
Without it the reset screen says so and nothing can be cleared.

Then in the lobby: pick the profile, choose **Forgot it?**, enter the key, and
clear it. Anyone signed in as that profile is signed out at the same time.

## Reconnecting

Your seat is held by a browser token in localStorage. Refresh, lose wifi, or
close the tab and reopen the link — you drop back into the same seat. While
you're gone a bot plays your hand so the table doesn't stall.
