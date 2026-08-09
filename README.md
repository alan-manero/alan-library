# Alan Library

A private, personal media library for the Alan project. You drag images in, they
are permanently stored in the cloud (Cloudflare R2), Claude analyzes them
automatically, and you can search and filter to find any image — and every video
that was generated from it.

This README is written for the project owner, who is not a professional
developer. Every command below can be copied and pasted as-is.

---

## What the pieces are (plain-language glossary)

| Thing | What it is |
|---|---|
| **Cloudflare Worker** | The server that runs the app. Cloudflare hosts it — you never manage a server. |
| **D1** | Cloudflare's SQL database. Stores all *information about* your media (tags, descriptions, statuses). Stores no actual image/video files. |
| **R2** | Cloudflare's file storage. Stores the actual images, videos and thumbnails permanently. |
| **Wrangler** | Cloudflare's command-line tool. Already installed inside this project (used via `npx wrangler ...`). |
| **Migration** | A small SQL file that updates the database structure. Applied with one command. |
| **Secret** | A private value (password, API key). Never stored in Git. |

---

## Requirements

Already installed on this computer (verified):

- Node.js v24
- npm 11
- Git

Accounts you need:

- **Cloudflare account** (free) — https://dash.cloudflare.com/sign-up
- **Anthropic API account** (needed from Phase 4, not yet) — https://console.anthropic.com

---

## Running the app locally (development)

1. Open a terminal in Cursor (menu: Terminal → New Terminal). It opens in the
   project folder automatically.
2. Run:

   ```
   npm run dev
   ```

3. Open http://localhost:5173 in your browser.
4. Log in with the local development password: `alan-dev`
   (You can change it in the file `.dev.vars`.)

Local development uses a **local copy** of the database and file storage, kept in
the hidden `.wrangler` folder. Nothing you do locally touches the real cloud data.

If you change the database structure (new migration files appear in
`migrations/`), apply them locally with:

```
npm run db:migrate:local
```

---

## One-time Cloudflare setup (for the real, deployed app)

You only do this once. All commands are run from the project folder.

### 1. Create a Cloudflare account

Go to https://dash.cloudflare.com/sign-up and sign up (free plan is fine).

> **Note about R2:** Cloudflare asks for a payment card to enable R2, even on
> the free tier (10 GB free). You are only charged if you exceed the free
> allowance. See "Costs" below.
>
> To enable R2: in the Cloudflare dashboard, click **R2 Object Storage** in the
> left sidebar and follow the "Purchase R2" / enable prompt (choose the
> pay-as-you-go plan; the free allowance applies automatically).

### 2. Connect Wrangler to your account

```
npx wrangler login
```

A browser window opens. Click **Allow**. That's it.

### 3. Create the database

```
npx wrangler d1 create alan-library-db
```

The output shows a `database_id` (a long code like `xxxxxxxx-xxxx-...`).
Copy it, open `wrangler.jsonc` in this project, and replace
`REPLACE_ME_AFTER_CREATING_D1` with that id. (Or paste the output to your
assistant in Cursor and ask it to do it.)

### 4. Create the file storage bucket

```
npx wrangler r2 bucket create alan-library-media
```

No id to copy — the name in `wrangler.jsonc` already matches.

### 5. Set up the database tables in the cloud

```
npm run db:migrate:remote
```

### 6. Set your production secrets

These are the real password and signing key for the deployed app.
Each command will prompt you to type/paste the value (it stays out of Git).

```
npx wrangler secret put APP_PASSWORD
```
Type the password you want to use to log into Alan Library. Choose a strong one.

```
npx wrangler secret put APP_AUTH_SECRET
```
Paste any long random string (40+ characters). You never need to remember it.
You can generate one at https://www.random.org/strings/ or just mash the keyboard.

(Later, in Phase 4: `npx wrangler secret put ANTHROPIC_API_KEY`)

### 7. Deploy

```
npm run deploy
```

The output shows your app's address, something like
`https://alan-library.YOUR-SUBDOMAIN.workers.dev`. Open it, log in with the
password from step 6, and you're live.

---

## Anthropic setup (Phase 4 — not needed yet)

1. Go to https://console.anthropic.com and create an account.
2. In the left menu, open **API Keys** → **Create Key**. Name it `alan-library`.
3. Copy the key (it starts with `sk-ant-`). It is shown only once.
4. For local development: paste it into `.dev.vars` after `ANTHROPIC_API_KEY=`.
5. For production: run `npx wrangler secret put ANTHROPIC_API_KEY` and paste it.

**DO NOT COMMIT `.dev.vars` or paste the key into any other file.**

---

## Updating the deployed app after code changes

Whenever code changes (e.g. after a Cursor session):

```
npm run deploy
```

If new files appeared in the `migrations/` folder, run this first:

```
npm run db:migrate:remote
```

---

## Costs (summary)

- **Workers (free plan):** 100,000 requests/day free — far more than one person needs.
- **D1 (free plan):** 5 GB storage, generous daily limits. Metadata is tiny; effectively free.
- **R2:** 10 GB storage free, then about $0.015 per GB per month
  (100 GB of media ≈ $1.35/month). Downloads are free (no bandwidth charges).
- **Anthropic API:** pay per image analyzed, roughly $0.005–0.02 per image
  depending on the model. Each image is analyzed once and the result is stored.

---

## Secrets — the golden rules

- `.dev.vars` holds local secrets. It is listed in `.gitignore`. **Never commit it.**
- Production secrets live only in Cloudflare (via `wrangler secret put`).
- `wrangler.jsonc` is safe to commit — it contains no secrets.

---

## Project structure

```
migrations/          Database structure, as numbered SQL files
src/worker/          The server (API, auth, later: uploads + AI analysis)
src/react-app/       The web interface (React)
wrangler.jsonc       Cloudflare configuration (safe to commit)
.dev.vars            LOCAL secrets — never committed
```
