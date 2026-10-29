---
title: "0007: Personal data leaves Bee Flow by e-mail only"
description: Why every outbound integration other than e-mail receives a ticket reference and at most a subject, built from an explicit allow-list of fields.
---

# 0007: Personal data leaves Bee Flow by e-mail only

**Status:** accepted, in effect. **Enforced by:** review, the `log-user-content` ratchet
for logs, and the allow-list builders in the integrations.

## Context

Bee Flow is a privacy product with zero-knowledge encryption (AES-256-GCM, Argon2id, OPAQUE).
Integrations with issue trackers and chat tools are expected, and the natural payload for
"a ticket was created" is the ticket: name, e-mail address, the customer's text. Once sent,
that data lives in a system Bee Flow does not control.

## Decision

Personal data leaves Bee Flow only by e-mail, where it goes to the person it concerns. To
every other outbound destination Bee Flow sends a ticket reference, plus at most the subject
when an organisation setting allows it (off by default). Never a name, an e-mail address, an
organisation, a phone number, an IP, a user agent, verbatim customer text or an attachment.
Such a payload is built from an explicit allow-list of fields, never by deleting keys from a
row: a column added next year would leak along. Fetching data from an external system is
not covered by this rule; the direction matters.

## Consequences

- An integration that needs more context shows it inside Bee Flow, behind the reference.
- Every new outbound payload is a small, reviewable builder.
- Logs follow the same line: a log call carrying personal data or user content is counted
  and may only decrease.
