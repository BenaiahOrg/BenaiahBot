# Benaiah Bot

A Telegram bot for exploring [Benaiah](https://www.benaiah.org)'s devotionals, study
materials and graphics in English and Amharic, with anonymous counseling and an
admin dashboard. It runs on [Telegram Serverless](https://core.telegram.org/bots/serverless)
(the same platform as the Sarah bot): no server to host.

## What it does

**Content** (live from the [Benaiah API](https://www.benaiah.org/developers), cached for an hour)

- Language chooser on first `/start`; switch any time with 🌐 or `/language`.
- The welcome message explains the name: Benaiah (בניה, Bana-yah) means “God has created / built”.
- Themes → topics → a topic card with its cover image, 📖 Devotional and 📝 Study
  material choices, and ✍️ Credits (authors, design and narration team).
- Choosing a devotional or study material opens its own options in the selected language:
  - 📖 Read sends one rich message (heading, date, authors, links), with buttons to
    switch language or article type and return to its options.
  - 🖼 Square graphics and 📱 story graphics, sent as photo albums (resized by Cloudinary, since
    Telegram won't fetch photos over 5 MB) with a 📥 Download originals button that sends the
    full-size PNGs as files. Each original is uploaded once; later requests reuse its Telegram file id.
  - 🎬 Videos and 📽 Shorts are sent as YouTube links with previews and watch buttons.
  - 🎧 Narrations are forwarded from the English or Amharic Telegram channel. If Telegram
    refuses forwarding (e.g. protected posts or channel access), a link to the original post is offered.
  - Video, Short and narration buttons appear only when that article and language have them.
  - ↗️ Share article opens a small Mini App sharing screen and Telegram's chat picker.
    The shared title is a clickable link, with no raw URL in the message. Available
    on the article options screen and below the text, in the selected language.
  - 🔖 Bookmark saves the selected article and language privately. Remove it from
    the article or the saved list. Bookmarks in the main menu (before About us), or
    `/bookmarks`, reopens saved articles even if the API catalog order changes.
- 🎲 Random devotional, 🔎 search (titles and descriptions, both languages), link to the website.
- ℹ️ About us: mission, the meaning of the name and origin story, how we work, the team, and
  contact/social links, all in the site's own English and Amharic wording.
- 🐞 Bugs & feature requests (inside About us): opens the Benaiah contact chat with
  an editable bug report or feature request template in the user's language.
- 🎨 Brand assets (inside About us): the logo as photos plus the original files (transparent PNG, white-on-black,
  black-on-white), looked up on benaiah.org daily so new uploads are picked up.
- If benaiah.org is down, the last cached copy is served.

**Anonymous counseling**

1. Someone taps 🤝 Anonymous counseling → Request, then writes a short first message
   (text or voice) about what they'd like to talk about. Nobody is notified before that.
2. A random free counselor gets that message, anonymously copied, with an Accept / Decline
   offer under it showing only a request number and language.
3. Decline, or no answer within 10 minutes, passes it to another random counselor.
   If nobody is free, the request waits in a queue and is offered as soon as a
   counselor finishes a session or resumes.
4. On accept, both sides get an "⏹ End session" keyboard and every message
   (text, voice, photos, stickers…) is relayed with `copyMessage`, so neither side
   ever sees who the other is. Messages written while waiting are delivered on accept.
5. Either side ends the session. Both get the main menu back; the person's has a 1–5 ⭐
   rating row on top. Cancelling a request also returns to the main menu.

Counselors can pause or resume new requests with `/counselor`. Message content
is never stored, only counts.

**Admin dashboard** (Mini App, opened with `/admin` or the menu button)

- Overview: users (total, new, active, by language), articles read, counseling
  requests, live/queued sessions, accept rate, average wait, session length, rating,
  and 14-day charts.
- Counselors: add by @username or numeric id, rename, pause/resume, remove; per
  counselor offers, accepts, declines, no-answers, accept rate, response time,
  sessions, ratings and their recent history.
- Admins: add by numeric Telegram user ID or a known @username, rename, and remove.
  New admins can use the dashboard, manage admins and counselors, and broadcast.
  Access is bound to the numeric account ID. `.env` admins remain protected owners;
  admins cannot remove themselves. Revoking access takes effect on the next request.
- Sessions: recent requests (anonymous) with status, wait, duration and rating.
- Content: most-read articles, top searches, reading language.

`/stats` gives admins a text summary in the chat.

**Admin broadcasts**

- Admins get a 📣 Broadcast button in the main menu and a `/broadcast` command.
- Send or forward one text or media message to the bot. It copies a preview back to
  the admin and shows the number of reachable recipients. Formatting and captions
  are preserved; albums must be sent as individual messages.
- Tap **Send to everyone** to confirm, or **Cancel broadcast** to discard it.
  The preview is the source of the delivered copies, so later edits to the original
  message cannot change what was reviewed. Admin controls are not copied to recipients.
- Delivery runs in batches of 20. Tap **Continue sending** for the next batch;
  `/broadcast` reopens an unfinished broadcast. Progress shows delivered, blocked
  and failed counts. Telegram rate limits pause delivery and display the wait time.
- Only the admin who created a broadcast can send or cancel it. Cancelling stops
  future deliveries; copies already delivered remain with recipients.

The welcome photo is the supplied image in `webapp/assets/welcome.png`, served
from this bot's Mini App host. The counseling button uses Telegram's default color.

## Deploy

1. In [@BotFather](https://t.me/BotFather): create the bot (or pick one) → **Serverless** → turn it on,
   then **CLI Access** → copy the access token (`app<id>:<secret>`).
2. Copy `.env.example` to `.env` and fill in:
   - `TGCLOUD` the CLI access token.
   - `ADMIN_IDS` your numeric Telegram id (and other admins'), comma separated.
     [@userinfobot](https://t.me/userinfobot) tells you yours.
   - `COUNSELORS` (optional) the counselors' @usernames or ids, comma separated.
     You can also add them later in the dashboard.
3. Install and deploy:

```bash
npm install
```

```bash
npm run deploy
```

`deploy` writes `tgcloud/lib/secrets.js` from `.env`, pushes the modules and the
dashboard, applies the database schema, and registers commands, the admin menu
button and the seed counselors. Run it again after any change.

4. Each counselor must open the bot and press Start once. Telegram doesn't let a
   bot message someone who hasn't, so until then the dashboard shows them as
   "Hasn't opened bot" and they get no requests.

## Develop

```bash
npm test
```

runs 38 end-to-end scenarios (browsing, articles, graphics, search, the whole
counseling flow including decline, timeout, queue, removal and blocked users,
and the dashboard endpoints) against the real `tgcloud/` modules, using a local
fake of the platform SDK (`test/fake-*.mjs`, backed by `node:sqlite`) and live
content from benaiah.org. It also writes `test/.db/demo.json`; serve the project
root (for example `python -m http.server`) and open `/test/preview.html` to see
the dashboard with that data.

Layout:

| Path | What it is |
|------|------------|
| `tgcloud/handlers/` | `message`, `callback_query`, `my_chat_member` (blocked/unblocked) |
| `tgcloud/endpoints/` | Dashboard API: `adminDashboard`, `adminCounselor`, `adminCounselorSave`, `setup` |
| `tgcloud/lib/bot.js` | Routes commands and buttons |
| `tgcloud/lib/views.js`, `content.js` | Content screens and the Benaiah API client |
| `tgcloud/lib/counseling.js` | Offers, accept/decline, timeouts, queue, relay |
| `tgcloud/lib/admin.js` | Counselor management and statistics |
| `tgcloud/lib/i18n.js` | Every user-facing string, English and Amharic |
| `webapp/` | The dashboard (plain HTML/JS, no build step) |
| `test/` | Local harness; not deployed |

Notes:

- The platform has no scheduler, so offer timeouts are checked whenever any
  update arrives (and when the dashboard opens). On a quiet bot an unanswered
  offer can sit longer than 10 minutes until the next message or button press.
- Callback buttons address content by position (`s:1:0` = theme 1, topic 0). If
  Benaiah reorders themes, old buttons in chat history open the new item at that position.
