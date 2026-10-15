# S2 report: admin compliance, modules, product website, org (batches 13–17)

- Branch: `ccr-ccac4823-i270ro`
- BASE: `9c28cceaa` = `origin/ccr-28820270-xkvwp8` (a3afd896) + `--no-ff` merge of `origin/ts-local/prep2` (fe97b2c6)
- Final commit: (filled at each push)

## Baseline measured on BASE (before any S2 work)
- check:fast 39/39 pass; server typecheck 0 errors; gitleaks clean.
- **Duplication is already red on BASE: production 15423 against a budget of 15419 (+4).** The convert branch alone
  measures 15379; prep2 adds +44, all from `agent-hub/src/components/admin/Studio/AppStudio/runtime/resolveBinding.ts`
  (now text-identical to `mobile/src/features/app-studio/core/runtime/{resolveBinding,paths,dataKeys}.ts`; the
  `.js` clone with `server/services/appStudioRender.js` drops out). Studio is b2-owned, so S2 does not touch it:
  integrator, turn the mobile port into a mirror entry. S2 holds itself to "no increase over 15423".
- ts-ratchet agent-hub: 2438 .js/.jsx (budget 2443).

## Batches
(in progress)
