---
title: LinkedIn
---

# LinkedIn

Post to LinkedIn as the connected user via OAuth. Every post is shown to the user for approval before it is published.

## Setup

1. Create a LinkedIn Developer App at [https://www.linkedin.com/developers/apps](https://www.linkedin.com/developers/apps).
2. Add redirect URI: `https://your-host/api/integrations/linkedin/callback`.
3. Set the client id and secret in **Admin → Organisation → Integrations → LinkedIn**. They are stored as encrypted secrets. As a fallback the server also reads `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` from the environment — note the names have no `OAUTH_` prefix.
4. Restart the server only if you used the environment variables; secrets set in the UI take effect immediately.

## Scopes

| Scope | Purpose |
|-------|---------|
| `openid` | Sign-in with OpenID Connect |
| `profile` | The member id and name of the connected user |
| `w_member_social` | Publish posts as the connected user |

## Tools

| Tool | Purpose |
|------|---------|
| `linkedin_create_post` | Create a LinkedIn post on behalf of the user. The post text will be shown to the user for approval before being published. |

This integration is intentionally minimal: one tool, which publishes a post as the connected user once they approve it. We don't expose tools that would scrape other users' profiles — LinkedIn's TOS forbid that.

## Use cases

- "Turn this release note into a LinkedIn post."

## Privacy

The access token is stored per user as an encrypted secret, together with the LinkedIn member id and name. Nothing is posted until the user approves the draft.
