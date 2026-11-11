---
title: "0020: App definitions have schema versions; the lowest sufficient version is written, and a corpus of stored apps gates every change"
description: Why an App Studio definition carries a schema version, why a definition is stored with the lowest version that covers what it uses, why anything newer is marked and optional, and how a corpus of real stored apps keeps every existing app working and looking the same.
---

# 0020: App definitions have schema versions; the lowest sufficient version is written, and a corpus of stored apps gates every change

**Status:** accepted, in effect. **Code:** `server/shared/appDefinition/schemaVersion.mjs` (the lowest
sufficient version), `server/appStudio/schemaSince.mts` (the index built from the catalogue),
`server/appStudio/componentSpecs/README.md` (the `since: 3` mark and where it goes),
`server/appStudio/canonicalize.js`, `server/appStudio/migrate.js`. **Enforced by:**
`server/appStudio/schemaVersion.test.js`, `schemaSince.families.test.js` and `catalogContract.test.js`
(every marked entry follows the rules, and no corpus app changes version while test fixtures are in
place), `server/appStudio/compat/*.test.js` (the frozen behaviour of every stored app: canonical
bytes, validator findings, step numbering, the public definition and the compiled SQL),
`npm run lint:compat-corpus` (`scripts/check-compat-corpus.mjs`, part of `check:fast`: a corpus or
frozen file that exists on the base may not be changed, deleted or renamed), and the pins in
`server/appStudio/componentSpecs/__tests__/baseVocabulary.pin.json`.

## Context

An app is stored as one JSON definition, and a published app runs on the definition as it was
published, possibly a year ago. Every reader of that definition (the validator, the web runtime,
the phone, the public page, the AI builder's prompt) has to keep reading old shapes. At the same
time the catalogue keeps growing: new components, steps, style settings, data options.

Two things go wrong when a definition format grows without a rule. A new default written into every
definition changes the bytes of apps nobody touched, and the next save rewrites them. And a
definition written by a newer release that an older server reads is silently normalised into
something else.

## Decision

- **A definition says which schema it needs.** `schemaVersion` is 2 for the frozen base catalogue.
  Everything added later carries `since: 3` on the place it is declared (a component type, a prop,
  an enum value, a step kind, a style setting, a top-level key, a data option).
- **The lowest sufficient version is written.** Canonicalising walks the definition and writes
  version 3 only when it uses something marked `since: 3`. A definition that uses nothing new stays
  version 2 and keeps its exact bytes.
- **New vocabulary is optional and emitted only when present.** Nothing new is filled in from a
  default into a definition that does not use it. Anything that would change how an existing
  formula or read evaluates applies to version 3 only.
- **A newer definition is refused, never normalised.** A version above the one the server knows is
  an error, not a guess.
- **The AI builder's pinned prompt does not move.** It renders the base tier; the extension tier
  reaches the model as an index and through `app_inspect_catalog`. The prompt's sha256, its
  ceilings and the pinned tool-schema hashes are part of the checks above.
- **A corpus of real stored apps gates every change.** `server/appStudio/compat/corpus/` holds apps
  as stored, `frozen/` what the code did with them on the day they were captured. Neither is edited
  once it is on `main`. A change that alters an existing app is red; it is made to leave existing
  apps alone, never refrozen. A new feature brings its own corpus app, added beside the old ones.

## Consequences

- A change to the catalogue is a file with a mark, not an edit to a shared list, and a new default
  for an existing thing is not possible. That is slower for the author and the point of the rule.
- Version 3 apps cannot be read by a server that does not know version 3. A rollback of the server
  past the release that introduced it has to account for that.
- The corpus and the frozen files only grow, which costs repository size and reading time. A
  deliberate change to how an existing app behaves is a decision for the owner, not a refreeze.
- Documentation of what is new (the Studio pages) is written from the same catalogue, so the
  user-facing statement "an app that does not use it is unchanged" is a tested property.
