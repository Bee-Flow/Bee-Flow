---
title: LinkedIn
---

# LinkedIn

Read-only LinkedIn lookups via OAuth.

## Setup

1. Create a LinkedIn Developer App at [https://www.linkedin.com/developers/apps](https://www.linkedin.com/developers/apps).
2. Add redirect URI: `https://your-host/api/integrations/linkedin/callback`.
3. Set the client id and secret in **Settings → Organisation → Integrations → LinkedIn**. They are stored as encrypted secrets. As a fallback the server also reads `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` from the environment — note the names have no `OAUTH_` prefix.
4. Restart the server only if you used the environment variables; secrets set in the UI take effect immediately.

## Scopes

| Scope | Purpose |
|-------|---------|
| `r_liteprofile` | Basic profile info |
| `r_emailaddress` | User's email |

(LinkedIn no longer permits broad search via OAuth for new apps. The `r_basicprofile` scope is grandfathered for some apps.)

## Tools

| Tool | Purpose |
|------|---------|
| `linkedin_get_profile` | Read the connected user's own profile. |

This integration is intentionally minimal. It exists so the assistant can ground answers in the user's actual current job title / company without manual entry. We don't expose tools that would scrape other users' profiles — LinkedIn's TOS forbid that.

## Use cases

- "Sign me up to the demo with my title and company."
- (Onboarding) Pre-fill the org admin's "headline" from LinkedIn.

## Privacy

Profile data is held in the user's session only — not persisted. Re-fetched on demand.
