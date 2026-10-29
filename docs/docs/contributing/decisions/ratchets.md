---
title: "0002: Quality is kept by ratchets"
description: Why Bee Flow records the current count of each known problem as a budget that may only go down, instead of fixing a category in one sweep or blocking only new files.
---

# 0002: Quality is kept by ratchets

**Status:** accepted, in effect. **Enforced by:** `npm run check:fast` and every
`lint:*-ratchet` script in the root `package.json`; budgets in `<package>/.<metric>-ratchet.json`.

## Context

A polyglot monorepo with more than a million lines carries old violations of every rule
worth having: inline styles, functions over 200 lines, `eslint-disable` comments, swallowed
errors, raw `db` access in routes, Dutch comments, import cycles, missing translations. A
rule that fails on all of them cannot be turned on. A rule that exempts old code lets the
count grow unnoticed. A big-bang cleanup conflicts with every open branch.

## Decision

Every such rule is a ratchet: a script measures the current count, a committed budget holds
the highest count allowed, and the check fails when the measurement exceeds the budget.
After an improvement, `--update` lowers the budget to the new measurement; raising a budget
is a deliberate edit that belongs in a commit message with a reason. ESLint runs the same way
through its bulk-suppressions files: no warnings, every rule an error, the old violations
recorded per file and rule, and `--suppress-all` is never used to get green. Coverage and
the number of type-checked files are ratchets in the other direction: floors that may only
rise.

## Consequences

- A rule can be adopted on day one for a codebase that violates it thousands of times, and
  the count can only shrink from there.
- Each ratchet is a file to update and a check to run; `check:fast` runs them all in a few
  seconds and lists them with `--list`.
- A branch that fixes violations and a branch that adds some merge without a textual
  conflict and the second one fails CI, which is the intended outcome.
- A ratchet measures a proxy. A JSDoc comment pushing a file past its line ceiling is the
  rule working as designed: the file is split, the ceiling is not raised.
