## What & why

<!-- What does this PR change, and what problem does it solve? Link related issues. -->

## Checklist

- [ ] Tests pass for the modules touched:
  - server: `cd server && npm test`
  - agent-hub: `cd agent-hub && npm run test:run && npm run typecheck && npm run lint`
  - Python services: `uvx ruff check guard-service pii-service reranker search-service whisperx-service`
- [ ] New/changed behavior is covered by a colocated test (`x.js` ↔ `x.test.js`)
- [ ] Secret scans are clean: `npm run lint:gitleaks && npm run lint:secrets`
- [ ] No new high/critical dependency advisories: `npm run lint:deps` (CI runs the same ratchet; see `.github/security/audit-baseline.json`)
- [ ] No real `.env` values, credentials, keys, or customer data in the diff
- [ ] Docs updated where behavior or commands changed

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.
