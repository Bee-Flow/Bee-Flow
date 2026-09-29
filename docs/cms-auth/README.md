# Bee Flow Docs — CMS auth relay

A small Cloudflare Worker that handles the GitHub OAuth handshake for the docs CMS at `/cms/`. ~140 lines, no dependencies, free tier.

It does exactly one thing: trade an OAuth code for a token and post it back to the editor's browser. Tokens are not stored. No content data ever passes through it.

> **Why this exists**: GitHub OAuth Apps require a server-side token exchange — there's no purely-static OAuth path. Hosting this tiny relay yourself replaces the third-party `auth.sveltia.app` dependency with one you fully control.

## One-time setup

You'll need a Cloudflare account (free) and a GitHub account.

### 1. Register a GitHub OAuth App

Open [github.com/organizations/Bee-Flow/settings/applications](https://github.com/organizations/Bee-Flow/settings/applications) → **New OAuth App** (or `github.com/settings/developers` for personal account).

| Field | Value |
|---|---|
| Application name | `Bee Flow Docs CMS` |
| Homepage URL | `https://bee-flow.github.io/docs/` |
| Authorization callback URL | `https://bee-flow-cms-auth.<your-cf-subdomain>.workers.dev/callback` *(you'll get the exact URL in step 3 — come back and update this field after deploying)* |

Click **Register application**. Copy the **Client ID**, then click **Generate a new client secret** and copy that too. Keep both safe.

### 2. Install Wrangler and log in to Cloudflare

```bash
cd cms-auth
npm install
npx wrangler login        # opens browser, authenticates against Cloudflare
```

### 3. Deploy the worker

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g. `https://bee-flow-cms-auth.<subdomain>.workers.dev`. Copy it.

### 4. Set the OAuth secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
# paste the Client ID from step 1, press enter

npx wrangler secret put GITHUB_CLIENT_SECRET
# paste the Client Secret from step 1, press enter
```

Secrets are encrypted at rest and only exposed to the worker at runtime.

### 5. Update the GitHub OAuth App callback URL

Go back to your OAuth App on GitHub. Update **Authorization callback URL** to:

```
https://bee-flow-cms-auth.<your-cf-subdomain>.workers.dev/callback
```

### 6. Point the CMS at your worker

Edit `docs/static/cms/config.yml` — replace the existing `base_url` with your worker's URL and remove the `auth_endpoint` line:

```yaml
backend:
  name: github
  repo: Bee-Flow/docs
  branch: main
  base_url: https://bee-flow-cms-auth.<your-cf-subdomain>.workers.dev
```

Commit and push. After the docs site rebuilds (~2 min), `/cms/` will route logins through your worker.

## Verifying it works

1. Open `https://bee-flow.github.io/docs/cms/`.
2. Click **Log in with GitHub**.
3. You should see GitHub's authorization screen for **"Bee Flow Docs CMS"** — not "Sveltia CMS". Authorize.
4. You land back in the CMS, logged in. Try editing a page.

If something fails, run `npm run tail` in this folder to live-tail the worker's logs.

## Optional: custom domain

The default `*.workers.dev` URL is fine. If you'd rather use `cms-auth.beeflow.nl`:

1. In Cloudflare Dashboard → your domain → Workers Routes, add `cms-auth.beeflow.nl/*` → `bee-flow-cms-auth`.
2. Or uncomment the `routes` block in `wrangler.toml` and re-deploy.
3. Update the OAuth App callback URL and the CMS `base_url` accordingly.

## Notes

- The worker rejects `site_id`s outside `bee-flow.github.io`, `docs.beeflow.ai`, `beeflow.nl`, and `localhost` — so a stranger can't trick it into completing OAuth flows for their site. Edit `ALLOWED_HOSTS` in `src/worker.js` if you add another domain.
- Free tier covers 100 000 requests/day. A login is ~2 requests; you'll never hit the limit on docs traffic.
- Updates to the worker code are deployed with `npx wrangler deploy`.
