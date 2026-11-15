---
title: "0028: Webhook callers that cannot sign may use a header token; signing stays the default"
description: Why an automation webhook accepts a fixed token in a header next to the HMAC signature, how the token is stored and compared, and what keeps the weaker mode from becoming the usual one.
---

# 0028: Webhook callers that cannot sign may use a header token; signing stays the default

**Status:** accepted, in effect. **Supersedes:** no earlier record. **Code:**
`server/usecases/automation/webhookReceive.mts` (the order of the checks and the answers),
`server/usecases/automation/webhookSignature.js` (`checkHeaderToken`, `tokenFromHeaders`),
`server/stores/automationStore/webhooks.js` (the `auth_mode` column, the stored hash, rotation),
`server/routes/automation/events.js` (where the token is read: headers only),
`server/routes/automation/runOpsSchemas.js` (`WebhookCreateBody.authMode`). **Enforced by:**
`server/usecases/automation/webhookReceive.test.js` (good and wrong token, a signature does not
open a token webhook nor the other way round, every delivery runs both checks, rotation, replayed
nonce), `server/routes/automation/events.webhookPayload.test.js` (a token in the query string is
refused, the token never reaches the run's headers), `server/stores/automationStore/webhooks.headerToken.test.js`
(only the sealed hash is stored, the token is handed out once, an existing row stays `hmac`),
`server/usecases/automation/webhookSignature.test.js` and
`server/routes/automation/webhooksAndRunOps.validation.test.js` (the default and the closed list of
modes).

## Context

An automation webhook accepted only a signed delivery: an HMAC over a nonce and the body. Some
callers cannot compute one. Monitoring tools, CRMs and workflow systems often offer just "a URL and
a secret header". Without a second way in, those callers need a relay in between, or the automation
cannot be used at all.

## Decision

- **Two modes per webhook, fixed when it is created.** `hmac` (the default, and what every existing
  webhook is) and `header_token`. The creation route takes `authMode`; without it the webhook is
  signed. A signature never opens a header-token webhook and a token never opens a signed one.
- **The token travels in a header only.** `Authorization: Bearer <token>`, or `X-BeeFlow-Token`
  when the caller cannot set `Authorization`. The route never reads a token from the query string,
  because addresses end up in logs and browser histories.
- **The token is not stored.** The server keeps the SHA-256 of the token, sealed like a signing
  secret, and compares hashes with `timingSafeEqual`. The token is in the creation (or rotation)
  answer once.
- **Same work for every delivery.** Each delivery is checked against a signature and a token, the
  current one and the one before it, with keys nobody holds where a webhook has none, so the time an
  answer takes does not tell the mode or whether the address exists. The refusal is the one
  `Delivery not accepted`; the owner reads the reason (`bad_token`) in the delivery log.
- **Everything else is shared.** Rotation with its changeover period, the rate limits per address
  and per IP, the answers, the delivery log and the headers a run may read work the same in both
  modes. A nonce is optional with a token; when one is sent, it is refused the second time.
- **The interface says it is weaker.** The builder offers signing first and marked as recommended;
  picking the token shows why it is weaker. The documentation says the same.

## Consequences

- Callers that cannot sign can start an automation without a relay.
- A header-token webhook is as strong as the secrecy of its token: a leaked token lets anyone send
  deliveries until it is rotated, and a captured request can be replayed unless the caller sends a
  nonce. That is the trade the mode names, and the reason it is never the default.
- A third mode (for example a signature scheme of a specific sender) is a new value in the same
  closed list, checked in the same place, with its own record.
