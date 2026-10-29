---
title: "0008: Licence keys are verified here and issued elsewhere"
description: Why this repository only verifies signed licence keys and gates premium features behind one middleware, while the server that issues keys stays private.
---

# 0008: Licence keys are verified here and issued elsewhere

**Status:** accepted, in effect. **Code:** `server/license/verify.js`,
`requireLicenseFeature('...')`; see `REPO-STRUCTURE.md`.

## Context

Bee Flow is fair-code: the source is public, and some features are sold. The repository
must be able to verify that an installation holds a licence for a feature without
containing the means to produce one.

## Decision

Licence keys are JWTs signed by Bee Flow's private license server. This repository holds the
verification only. A premium feature sits behind `requireLicenseFeature('<feature>')` on
its route; nothing else in the code asks what the licence says.

## Consequences

- A fork can run every open feature and cannot mint keys.
- A new premium feature is one middleware on its routes and one feature name on the
  issuing side.
- The issuing server is a separate deployment with its own release cadence.
