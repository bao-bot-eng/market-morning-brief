# US Market Morning Brief Web App

Private web app for generating a bilingual US premarket news brief on phone or desktop.

This tool is for market observation and learning only. It does not provide buy, sell, hold, or price prediction advice.

## What It Does

- Username/password login through a Supabase Edge Function.
- Short-lived signed session token stored in browser `localStorage`.
- One-click Gemini generation with Google Search grounding.
- Bilingual English + Chinese dashboard output.
- Quick Mode for fast reading and Reading Mode for full detail.
- Markdown copy/download.
- Recent 20-brief history, open, and delete.
- Automatic cleanup of briefs older than 30 days whenever a new brief is generated.
- Database access only through Edge Functions.

## Project Structure

```text
frontend/
  index.html
  style.css
  app.js
  config.example.js

supabase/
  config.toml
  functions/
    _shared/
      cors.ts
      db.ts
      session.ts
    login-market-brief/
      index.ts
    generate-market-brief/
      index.ts
    briefs-market-brief/
      index.ts
  migrations/
    create_market_briefs.sql
```

## Values You Need To Provide

You do not need to put these in the code. Set them as Supabase secrets:

- `APP_USERNAME`: your login username.
- `APP_PASSWORD`: your login password.
- `APP_SESSION_SECRET`: a long random string for signing session tokens.
- `GEMINI_API_KEY`: your Gemini API key.
- `GEMINI_MODEL`: for example `gemini-2.5-flash`.

The frontend only needs:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Do not put `GEMINI_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in the frontend.

## Create Gemini API Key

1. Open Google AI Studio.
2. Create an API key.
3. Confirm the selected Gemini model supports Google Search grounding in your region/account.
4. Check current pricing, Google Search grounding availability, and free quota in the official Google docs before regular use.

## Create Supabase Project

1. Create a Supabase project.
2. Copy your project URL and anon key for frontend config.
3. Confirm Edge Functions are available on your Supabase plan.

## Run SQL Migration

In the Supabase SQL editor, run:

```sql
create extension if not exists pgcrypto;

create table if not exists public.market_briefs (
  id uuid primary key default gen_random_uuid(),
  us_date date not null,
  sydney_date date not null,
  generated_at timestamptz not null default now(),
  brief_json jsonb not null,
  markdown text,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists market_briefs_generated_at_idx
  on public.market_briefs (generated_at desc);

create index if not exists market_briefs_us_date_idx
  on public.market_briefs (us_date desc);

alter table public.market_briefs enable row level security;

drop policy if exists "No direct anon access" on public.market_briefs;
create policy "No direct anon access"
  on public.market_briefs
  for all
  using (false)
  with check (false);
```

This table is private. The browser cannot access it directly; Edge Functions use service role permissions.

## Set Supabase Secrets

From the project root, after linking your Supabase project:

```bash
supabase secrets set APP_USERNAME=your_username
supabase secrets set APP_PASSWORD=your_password
supabase secrets set APP_SESSION_SECRET=random_long_secret_string
supabase secrets set GEMINI_API_KEY=your_gemini_key
supabase secrets set GEMINI_MODEL=gemini-2.5-flash
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available to Edge Functions in Supabase-hosted projects.

## Deploy Edge Functions

Because this app uses its own session token, the functions are configured with `verify_jwt = false` in `supabase/config.toml`.

Deploy:

```bash
supabase functions deploy login-market-brief
supabase functions deploy generate-market-brief
supabase functions deploy briefs-market-brief
```

Only `generate-market-brief` calls Gemini. Login and history requests do not consume Gemini API quota.

## Configure Frontend

Create `frontend/config.js` from `frontend/config.example.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://your-project.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key",
};
```

Only the anon key belongs here.

## Deploy Frontend

The frontend is static HTML/CSS/JS. You can deploy the `frontend/` folder to:

- Netlify
- Vercel static hosting
- Cloudflare Pages
- GitHub Pages

After deployment, open the site URL on your phone browser and log in with `APP_USERNAME` and `APP_PASSWORD`.

## Use The App

1. Open the deployed frontend URL.
2. Log in with username and password.
3. Confirm `US Date` and `Sydney Date`.
4. Select whether to include next 1-2 week events.
5. Choose Quick or Reading mode.
6. Click `Generate Morning Brief`.
7. Use `Copy Markdown`, `Download Markdown`, or `View History`.

If a brief already exists for the same US date, the app asks whether to open the existing brief or regenerate.

## Common Errors

- `Invalid username or password`: check `APP_USERNAME` and `APP_PASSWORD` secrets.
- `Session expired`: log in again. Tokens last about 12 hours.
- `Gemini API key missing`: set `GEMINI_API_KEY`.
- `Gemini quota exceeded`: check Gemini billing/quota and retry later.
- `No reliable source links returned`: Gemini returned no grounding URLs; verify manually.
- `JSON parse failed`: Gemini did not return valid JSON. The function response includes `raw_response` for debugging.
- `Supabase insert failed`: check table migration and service role availability.

## Local Preview

For a static preview, open `frontend/index.html` in a browser after creating `frontend/config.js`.

Generation and history require deployed Supabase Edge Functions.
