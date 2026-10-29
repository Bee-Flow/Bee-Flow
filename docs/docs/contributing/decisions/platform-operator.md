---
title: "0009: One built-in platform-operator account, by fixed id"
description: Why an installation has exactly one account it cannot be without, identified by the fixed id admin, and why that comparison lives in a single module.
---

# 0009: One built-in platform-operator account, by fixed id

**Status:** accepted, in effect; a role-based replacement is an open question. **Code:**
`server/auth/platformOperator.js`; the `admin-id-literal` ratchet keeps the literal there.

## Context

An installation is set up with one account. It must survive every mistake an administrator
can make: it cannot be deleted or demoted, it exists from configuration before its database
row does, and some views are its alone (raw token and message counts instead of the
marked-up cost). "Is this user a super admin" is a different question that any number of
accounts can answer yes to.

## Decision

The platform operator is the account with the fixed user id `admin`. The comparison is made
in one module, `isPlatformOperator`, and the ratchet `admin-id-literal` fails any other
comparison of a user id or username with the literal. The same check reserves the name at
signup and user creation.

## Consequences

- One place to read, one place to change.
- The identity is a name, not a role or a claim: an installation cannot have two operators,
  and the operator's privileges cannot be granted to another account. Moving this to an
  explicit role in the RBAC layer, with a migration for existing installations and a rule for
  existing sessions, is the alternative on the table; it is a change to authentication and
  needs a design of its own before any code.
