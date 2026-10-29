---
title: "0005: Generated copies, never hand copies"
description: Why the expression engine, the English dictionary, the API reference and the editor bundles each have one source and generated targets that a check compares byte for byte.
---

# 0005: Generated copies, never hand copies

**Status:** accepted, in effect. **Enforced by:** `lint:shared-mirror`, `lint:i18n-gen`,
`lint:api-reference`, `lint:editor-bundles`.

## Context

Several pieces of code must exist in more than one package. The expression engine runs in
the server, the SPA and the mobile app, and the SPA's image cannot see `server/`. The
frontend needs the English dictionary the server owns. The documentation site needs an
account of every route and schema. The server needs the editor's serialisation code as a
CommonJS bundle. A copy kept by hand drifts the first week nobody looks at it.

## Decision

Each has one source and one generator. `server/shared/expr/` is the source of the
expression engine; `agent-hub/src/shared/expr/` and `mobile/src/shared/expr/vendor/` are
byte-for-byte generated copies listed in `scripts/shared-mirror.manifest.json`. The English
dictionary is `server/i18n/defaults/en/<namespace>.js`, one file per namespace, and
`agent-hub/src/i18n/en-defaults.js` is generated from it. The OpenAPI document and the
reference pages are generated from the running router. The editor bundles carry a hash of
their inputs in their banner. Every check recomputes and fails on a stale or hand-edited
target; a transformed copy starts with a `GENERATED` header.

## Consequences

- After changing a source, the generator runs and both sides are committed; CI fails
  otherwise.
- The namespace rule keeps one writer per dictionary file: two branches adding to the same
  file merge without a visible conflict and the second one silently wins, so the key guard
  fails a PR that drops a key the base had.
- A new generated copy is an entry in a manifest, never a copied file.
