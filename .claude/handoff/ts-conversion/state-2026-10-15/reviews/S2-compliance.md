# Opus review s2/compliance (b13 + b14, BASE 9c28ccea, tip 08ae0940): b13 CHANGES REQUIRED (1 line), b14 CHANGES REQUIRED (small)
Nothing blocks on correctness. The compiled program is identical to BASE except the 6 catch-helper lines, and those are equivalent. The required fixes are a guard regression (one regex), one duplicate shape and one misplaced type. All are small and can go in one fix commit before the merge.

## Gate and checks (all run in a scratch worktree of 08ae0940; scratch trees removed)
- **Equivalence gate per commit:**
  - types commit c2698ab9 (b13): `7 identical, 0 different of 7`
  - types commit 3a7f860c (b14): `25 identical, 0 different of 25`
  - pass 2 commit 08ae0940 vs f4e2adb3: `2 identical, 0 different of 2`
- **Equivalence gate overall:** `33 identical, 2 different of 35`. The 2 are the catch files QuestionnaireImport.tsx and SideloadDialog.tsx. The diff holds only the recipe tokens and the import lines (see Catch commits). The SideloadDialog type-only part never went through a types commit. The overall diff against BASE shows nothing beyond the 4 token lines and the import, so that part is proven type-only too.
- **D/A pairs:** `git diff --name-status -M40%` shows only R and M entries, plus one A (`settingsFields.types.ts`, types only, no JS counterpart). There are no D/A pairs, so pair-check had nothing to compare.
- **Leftover JS:** the 55 paths left in batches/13.txt and 14.txt are all byte-identical to BASE. 35 paths were converted, which matches the gate's 35.
- **Typecheck:** `heavy.sh npm run typecheck` (agent-hub): 0 errors.
- **eslint** on the changed files: 0 errors, 27 warnings (complexity, max-lines, plus 2 old warnings in i18nGuard.test.js), no new eslint-disable.
- **Ratchets:**
  - `duplication-ratchet`: production 15423, identical to BASE (15423 against the 15419 budget, so this branch adds 0). Test: 26228.
  - `file-budget`: at budget, nothing past its ceiling. settingsFields.ts is 411 lines, exactly its ceiling.
  - `ts-ratchet`: 2403 JS files against a budget of 2443 (not updated, as the brief asks).
- **vitest:** the 29 files next to or importing the changed files: 29 files and 343 tests pass. The run covered checkSort, railMeta, SetupSteps, SetupCard, SeverityTag, VerificationChip, StatusPill, UserPicker, maskEmail, FrameworkCandidateCard, VersionHistory, PermissionConsentDialog, moduleDeepLink, permissionCopy, purchaseReturn, modalOverlays, MarketplaceTab, ModulesPanel, the Dsr/Frameworks/CustomFrameworks/Settings/Incidents/Overview/Soa/Framework pages, settingsLayout, noPurple and i18nGuard.
- **mobile:** `heavy.sh ./node_modules/.bin/jest src/features/compliance`: 9 suites and 125 tests pass. No server or scripts test reads these agent-hub paths.
- **Merge test:**
  - **Integrator:** `git merge-tree --write-tree ccr-ccac4823-i270ro s2/compliance` is clean. The integrator is NOT just BASE plus one docs commit: it also holds 80112891, the wave1 merge, which touches 147 files. The only shared files are `.file-budget.json` and `i18nGuard.test.js`, and both merge automatically.
  - **Merged tree:** typecheck gives 0 errors. Duplication is 15375 with or without this branch.
  - **Batch 17:** `s2/batch-17` has 4 commits (ccdba2f7, 8d0e5d90, 0a7c0080, d70ca8a3), and merge-tree against it is clean with no textual conflicts.

## Catch commits
- 4768fda3, QuestionnaireImport.tsx:157: `String(e?.message || 'error')` became `String(messageOf(e, 'error'))`. This is the recipe row `V.message || '<literal>'`, so the same text comes out. The only difference is a non-string message, which the helper documents. It needs no `// behaviour:` note.
- bcbf1e37, SideloadDialog.tsx:43/59/60/88:
  - `errText`: `e?.body?.error || e?.message` became `errorBodyRecord(e)?.error || errorMessage(e)`. The two are equal: a string body gave `undefined` for `.error` before and gives `undefined` now. A non-string truthy `body.error` passes through unchanged. The slug is only compared to literals.
  - `e.body.missingPermissions` became `errorBodyRecord(e)?.missingPermissions`. It is evaluated only when `e?.body?.error === 'consent_required'`, which means the body is a non-null object. So the old throw (a missing body) cannot be reached, and `errorBodyRecord(e)` returns that same object. This is not a behaviour change, and "no // behaviour: notes" is correct.
  - `e?.status` became `errorStatus(e)`, compared with `=== 402` / `=== 404`. Equal.
- **Process note (no fix needed at the tip):** types commit c2698ab9 already contains `QuestionnaireImport.tsx` with `catch (e) { … e?.message … }`. On its own that commit does not typecheck (TS18046). The brief says that file stays JS in commit 1 and converts in the catch commit, the way bcbf1e37 does it for SideloadDialog. Mention it in the S2 report; do not rewrite history.

## Forbidden constructs
- `git diff 9c28ccea..08ae0940 -- agent-hub/src mobile` has none of the following:
  - `any`, `as any` or `as unknown as`
  - `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`
  - a non-null `!`
  - a new eslint-disable
- **Casts:**
  - DsrCaptureModal.tsx:66 `(CHANNEL_WIRE as Record<string, string>)[channel]` is a widening of a frozen literal object to a supertype. It is acceptable.
  - Two `any` flows pass through without a syntactic cast:
    - `JSON.parse` in SideloadDialog.tsx:72: guarded at the site by `grant && (grant.module_id || …)`, so it is acceptable.
    - `Array.isArray(unknown)` in settingsFields.ts:333 `asArray<T>` and permissionCopy.ts `normalizePermissions`: see nit 9.

## b13 (compliance pages: QuestionnaireImport, DsrCaptureModal, PublicFormTab, checkSort, FrameworkCandidateCard, frameworkIcons, IncidentCreateModal)
1. **REQUIRED, guard regression.** The hygiene scan in agent-hub/src/components/admin/compliance/pages/FrameworkPage.test.jsx:356 filters `framework/` with `/\.jsx?$/`. checkSort.js is now checkSort.ts, so it silently left the "no hex / no --status- / no purple" scan. AffectedProjects.tsx, AutoFixConfirm.tsx, FindingDecision.tsx and phaseRules.ts were already outside it. Fix:
   `...fs.readdirSync(path.join(dir, 'framework')).filter((f) => /\.[jt]sx?$/.test(f) && !f.includes('.test.'))…`
   I checked that checkSort.ts holds no hex.
2. **Honest as written, no change:**
   - **CheckRecord** `status: string; severity: string` (checkSort.ts:35-36): required matches `compliance_checks.status TEXT NOT NULL` and `severity TEXT NOT NULL DEFAULT 'medium'` in server/stores/compliance/schema.js:60-61.
   - **IncidentCreateModal** `onClose: () => void` (IncidentCreateModal.tsx:40): required is honest even though line 73 calls it as `onClose?.()`. It goes to `Modal onClose` at line 98, and Modal requires `onClose` (shared/Modal.tsx:35) and calls it without a guard (line 275). The only caller, IncidentsPage.jsx:221, passes it.
   - **CandidateFramework.locked** `'ceiling' | 'not_granted' | null` matches `_lockReason` in server/compliance/frameworkPolicy.js:190-196. **relevance** matches the server's serializer (server/routes/compliance/frameworks.js:122-148).
3. **Nit:**
   - QuestionnaireImport `onImport?: (rows) => unknown` and IncidentCreateModal `onCreate?: (body: unknown) => unknown` are loose but honest. The producers (incidentClocks.js `createBodyOf`) are still JS. Tighten when incidentClocks converts.

## b14 (compliance shared/setup/settings/overview/railMeta, admin/modules)
4. **REQUIRED, one home per shape.** permissionCopy.ts:9-12 `export interface ModulePermission { id: string; reason?: string | null }` is the same shape as `ModulePermissionEntry` in agent-hub/src/api/queries/modules.ts:247-250, which already exists. It also landed between the "Fixed ids → dict keys" comment (lines 7-8) and `PERM_KEY` (line 14), so that comment now describes the interface. Fix:
   - Delete lines 9-12.
   - Add `import type { ModulePermissionEntry } from '../../../api/queries/modules';` and `export type ModulePermission = ModulePermissionEntry;`, placed ABOVE the `// Fixed ids` comment.
   - The importers (PermissionList, PermissionConsentDialog, SideloadDialog) keep working unchanged.
5. **REQUIRED, contract rule "types never between JSDoc and function".** In moduleDeepLink.ts:6-7, `/** Module id to open the drawer for, or null. */` now sits on `type UrlLocation = …`, not on `parseModuleDeepLink`. Fix: move `type UrlLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;` (plus a blank line) above line 6, directly after the header comment block.
6. **Recommended, type honesty.** MarketplaceModuleCard.tsx:10 `type CardPricing = MarketplacePricing & { model?: string; amountCents?: number | null };` keeps `type` required. The comment above it and `priceLabel` (`pricing?.type || pricing?.model`) say a legacy `{ model, amountCents }` row has no `type`. Fix: `type CardPricing = Partial<MarketplacePricing> & { model?: string; amountCents?: number | null };`. That typechecks, because `priceLabel` already handles `!type`.
7. **Recommended, one name for the policy payload.** `{ channel: string; pin: string }` is spelled out 5 times:
   - UpdatePolicySelector.tsx:8
   - MarketplaceModuleCard.tsx:24, 263
   - ModuleDetailDrawer.tsx:22, 212

   Fix: export `export interface PolicyChange { channel: string; pin: string }` from UpdatePolicySelector.tsx and import it at the other 4 sites. Use `string`, not `UpdatePolicy`'s unions, because the value is `e.target.value`.
8. **Nit, OrgUser has 4 homes now.**
   - The new one is UserPicker.tsx:4 `OrgUser { id: string; displayName?: string; email?: string; phone?: string | null; orgRole?: string | null }`. It matches GET /api/compliance/org-users (server/routes/compliance/orgUsers.js:39-45): id, a displayName that is always filled, email, `phone || null` and `orgRole || null`. So it is honest, and the optional fields are only lenient.
   - The three older copies differ (`id: string | number; displayName?: string | null; email?: string | null`):
     - pages/dsr/dsrTimeline.ts:22
     - pages/audits/ObjectiveDrawer.tsx:52
     - pages/accessAuditLabels.ts:38

   They are not part of this branch. Leave them for an integrator follow-up that points all four at UserPicker's type. Do not widen UserPicker's type to `| null` now: SetupSteps.tsx:187 `update({ dpo_name: u.displayName, … })` would then stop typechecking.
9. **Nit, hidden cast.** settingsFields.ts:333 `const asArray = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? v : []);` returns `any[]` as `T[]`, and the call sites `asArray<Contact>(…)` / `asArray<Contact | null | undefined>(v)` claim the element type without a guard. It is harmless, because `Contact`'s fields are all `unknown` and the reads are `c?.name` / `asText(c.name)` behind `c && typeof c === 'object'`. Accept it, but add a one-line comment above `asArray`: `// T is the caller's claim; every read of an element is guarded (typeof/optional chaining) at the site.`
10. **Nits, cosmetic:**
    - settingsFields.ts:16: the `import type` line replaced the blank line after the header comment. Put back a blank line before the import and one after it.
    - SideloadDialog.tsx:11-15/56: `SideloadResult` and the inline `{ version: string; requiresRestart?: boolean } | null` could use `SideloadResponse | null` (modules.ts:236). `SideloadResult` itself is a separate UI state and may stay.
    - purchaseReturn.ts:12-14, 27-28, 40-41: the `@param` / `@returns` lines only repeat the new types. The brief says to delete them; keep the prose lines. Its two `Pick<Location, …>` shapes could share moduleDeepLink's `UrlLocation` (export it).
11. **Honest as written, no change:**
    - **SeverityTag** `severity: string` and **VerificationChip** `verification: string` (pass 2). The only caller, AttentionList.jsx:168-169, renders them only behind `showSeverity` (`… && !!severity`) and `VERIFICATION_KINDS.includes(verification)`. So a string always arrives. Optional is not possible without a code change (`LABEL[undefined]` is not an index type).
    - **StatusPill** `tone?: keyof typeof TONES` is narrower than the runtime contract (an unknown tone falls back to neutral, and StatusPill.test.jsx tests that). The narrowing is forced by `TONES[tone]`. The callers are JS for now: NcsTab and AuditsTab pass `toneOf(...)`. Whoever converts them types `toneOf` to return `keyof typeof TONES`.
    - **SetupSettings / SetupBody / SetupData** match POST /auto-detect-settings (server/routes/compliance/settings.js:236-242: `privacy_notice_url` may be null, `default_retention_days` is a number) and the `setupBody` allow-list. The allow-lists that matter for privacy (`capturePayload`, `setupBody`, `buildSettingsBody`) compile to identical JS (gate), so no new field can travel.
    - **ModuleDetailActions** (ModuleDetailDrawer.tsx:14-27) mirrors the JS hook moduleActions.js:238-246, the only thing it can do while that hook is JS. `onPolicyChange(module, policy)` at MarketplaceModuleCard.tsx:263 sits in a closure behind the `onPolicyChange &&` guard at line 258, on a never-reassigned parameter, which is fine.

## Importers and source-reading tests
- **No extension-named imports** of the renamed files remain in code.
- **Lockstep and source-reading edits:**
  - mobile/src/features/compliance/model/lockstep.test.ts:33 `settingsFields.js` → `.ts` is correct. The regex `name: '…', kind: '…'` still matches the typed table, and jest passes.
  - i18nGuard.test.js:420 KEY_TABLE_FILES `.js` → `.ts` is correct.
  - agent-hub/.file-budget.json changes only one key (`settingsFields.js` → `.ts`, still 411).
- **noPurple.test.jsx** walks `jsx?|tsx?` and keeps covering the converted files. FrameworkPage.test.jsx does not (finding 1).
- **Stale comments** that name the old `.js` file. Optional, and fix them only in TS or mobile files; the JS files must stay byte-identical:
  - settings/settingsLayout.ts:3
  - modules/moduleDeepLink.ts:2 (`purchaseReturn.js`)
  - mobile/src/features/compliance/model/lockstep.test.ts:4
  - mobile/src/features/compliance/model/settingsFields.ts:3
  - mobile/src/features/compliance/model/counts.ts:2 (`railMeta.js`)

## Merge order
After the fixes (1, 4, 5; 6 and 7 recommended), merge s2/compliance into the integrator. It is textually clean and the merged typecheck has 0 errors. Batch 17 has no textual conflict with it. After the merge, re-run `npm run typecheck` (agent-hub) and the `mobile` compliance jest on the combined tree, because the integrator moved by 147 files since BASE.

## Resolution (S2, fix commit on s2/compliance before the merge)
Required 1–3 applied. Recommended applied (CardPricing `Partial<MarketplacePricing>`, one `PolicyChange` exported from
UpdatePolicySelector). Nits applied: SideloadResponse in the success handler, asArray note (trailing comment: the file is at
its 411-line ceiling, so the blank-line nit is skipped), purchaseReturn @param/@returns lines that only repeat types.
Left for the integrator: OrgUser has 4 definitions; stale comments naming old `.js` files.
Process note: b13's types commit c2698ab9 holds QuestionnaireImport.tsx with `e?.message` on an unknown catch variable, so
it does not typecheck alone; the next commit (4768fda3) fixes it. History not rewritten.
