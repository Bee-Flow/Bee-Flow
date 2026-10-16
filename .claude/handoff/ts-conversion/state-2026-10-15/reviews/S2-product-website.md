# Opus review: s2/batch-17 (BASE 9c28ccea, tip d70ca8a3) and s2/batch-16 (tip 05c9d2b4)

**Verdicts**
- **b17: CHANGES REQUIRED (small).** Two shapes are defined twice inside the branch, and 13 component JSDoc blocks were separated from their functions by the new Props types. Everything else is recommended or a nit. The catch commit is approved. The security code has no logic change and no fail-open.
- **b16: CHANGES REQUIRED (small).** Seven lines were mangled by the editing tool, one plan shape duplicates an existing type and is also wrong about `price`, and one `secondaryCta` type leaves out the `null` that the code writes.
- **0a7c0080: KEEP.**

Nothing blocks on correctness. The compiled program equals BASE except the recipe tokens. All fixes fit in one fix commit per branch.

## 1. Gates and checks
I ran these in a detached scratch worktree of s2/batch-16 and in a scratch merge commit (`git commit-tree` of the merge-tree result). Both were removed afterwards.

**Equivalence gate**

| Range | Result |
|---|---|
| 9c28ccea..ccdba2f7 (b17 types) | `35 identical, 0 different of 35` |
| ccdba2f7..8d0e5d90 (b17 catch) | `0 identical, 8 different of 8` (expected; see §2) |
| 8d0e5d90..0a7c0080 (move) | `0 of 0` (no rename; byte check in §3) |
| 0a7c0080..d70ca8a3 (shared.tsx) | `1 identical, 0 different of 1` |
| s2/batch-17..485c49da (b16 types) | `27 identical, 0 different of 27` |
| 485c49da..05c9d2b4 (b16 catch) | `0 identical, 1 different of 1` (PricingEditor, token only) |
| 9c28ccea..s2/batch-16 (overall) | `62 identical, 10 different of 72`. The 10 are the 9 catch files plus shared.tsx, which lost GroupedItemsField to the pure move. |

- **The catch diffs hold only recipe tokens.** In `--diff` for both catch commits, every differing line is either an `err.message`/`e.message` token line or the `caughtError` import.
- **D/A pairs:** `git diff --name-status -M40% 9c28ccea s2/batch-16 -- agent-hub/src` shows only R and M, plus five A files with no JS counterpart: `analytics/ui.types.ts`, `blockEditors/GroupedItemsField.jsx`, `HeaderEditor.types.ts`, `editorProps.ts` and `primitives.types.ts`. There are no D/A pairs, so pair-check had nothing to do.
- **Leftover JS:** the 34 paths still JS in batches/17.txt and 16.txt are byte-identical to 9c28ccea. The 72 converted paths match the gate's 72.
- **Process:** each catch file is JS in its types commit and converts only in the catch commit. This avoids the b13 problem. PricingEditor is JS in 485c49da.

**Merge test:** `git merge-tree --write-tree ccr-ccac4823-i270ro s2/batch-16` → `4d69c66d`, clean, with no conflicts. These results are on that merged tree:
- **Typecheck:** `heavy.sh npm run typecheck` gives 0 errors (rc=0).
- **eslint** on the 79 changed or added files: 0 errors, 47 warnings, all complexity, max-lines-per-function or max-statements. There is no new eslint-disable, and no converted file contains one.
- **Ratchets and dead code:**
  - `duplication-ratchet`: production 15324, under 15419 ✅. Test: 26228.
  - `file-budget agent-hub`: ✅, none past its ceiling. The ui.jsx→tsx key was renamed in `.file-budget.json`.
  - `ts-ratchet`: 2220 against a budget of 2443 (not updated).
  - knip (`npm run lint:dead`): clean. GroupedItemsField.jsx is reached through the re-export.
  - `npm run check:fast`: 39 passed, 0 failed.
- **vitest** `src/components/admin/product-website src/components/admin/security`: 72 files and 779 tests pass.
- **Source readers:** no mobile, server or scripts test reads a converted path. No directory-scan test with `/\.jsx?$/` covers these folders. No importer names a renamed file with its extension.

## 2. Catch commits (8d0e5d90, 05c9d2b4): per site

| Site | Change | Right? |
|---|---|---|
| AssetPickerDialog.tsx:57 | `err.message \|\| ''` → `messageOf(err, '')` | Yes, recipe row. |
| useCmsAutosave.ts:98, useCmsPageMeta.ts:63, useCmsPublishing.ts:146 | `setError(err.message)` → `messageOf(err, '')` | **Acceptable, keep (see below).** |
| useCmsPublishing.ts:92, 105, useCmsSiteOps.ts:300 | `toast.error(err.message)` → `messageOf(err, '')` | Yes. `toast.error(message: string)` (shared/Toast.tsx:89) makes the target a string, so the recipe's messageOf exception applies, and the `// behaviour:` note is present. |
| template literals (autosave, pageMeta, publishing, siteOps ×4) | `${err.message}` → `${errorMessage(err)}` | Yes, recipe row ("undefined" printed as before). |
| useCmsSiteOps.ts:135, 203 | `err.message \|\| 'Export failed'/'Import failed'` → messageOf | Yes. |
| MicrosoftIdentityPanel.tsx:37, 45 | `setError(errorMessage(err))`, state `useState<string \| undefined>('')` | Yes, the recipe default. It renders `{error && …}`. |
| OrgEncryptionEditor.tsx:80 | `setLoadError(errorMessage(err))`, state `string \| null \| undefined` | Yes, the recipe default. |
| OrgEncryptionEditor.tsx:115 | `err.message \|\| t(...)` → `messageOf(err, t(...))` | Yes. `t` is cheap and has no side effect, so the eager fallback is fine. |
| DirectChatView.tsx:50 | `e.message \|\| 'Failed to save'` → messageOf | Yes. |
| PricingEditor.tsx:88 | `err.message \|\| 'Failed'` → messageOf | Yes (formatting broken, see finding 12). |

The three `setError` sites are the only judgement call:
- The recipe's default is "type the state as what JS stored and pass `errorMessage(e)`". Here the state lives in an already-TS file, `useCmsPanelState.ts:65` `useState<string | null>(null)`, which `useCmsSiteLoader` also writes.
- Its only reader is `PanelStage.tsx:39` → `PreviewStage` `errorText ? …`, a truthiness check. `''` and `undefined` therefore render the same: no strip.
- Widening the panel state would loosen an existing TS file for no visible difference.
- So messageOf is the right choice here, and the commit's `// behaviour:` note covers it.

`useGuardrailsData` `error` is typed `useState<unknown>(null)` (recipe 15b). Its only consumer, `GuardrailsHub.jsx:85`, reads only truthiness, so it needs no `TODO(err-unknown)`.

## 3. 0a7c0080 (move GroupedItemsField): KEEP
- **The move is byte-identical.** Lines 5–96 of the new `GroupedItemsField.jsx` are identical to the 92-line block removed from `shared.jsx`, from the `// GroupedItemsField` comment through the end of the function. The new file's header holds exactly the three imports the function needs.
- **Importers are unchanged.** `shared.jsx`/`.tsx:16` does `export { GroupedItemsField } from './GroupedItemsField';`, and the only importer, ArchitectureEditor.jsx (still JS), is untouched.
- **Ratchet count:**
  - The move adds one JS file and d70ca8a3 removes one, so the net change to the ts-ratchet is 0.
  - In exchange, `shared` converts, and with it most of the 27 b16 editors that import `set` / `SectionHeaderFields` / `CtaButtonField`.
- **knip is clean.** No import cycle is added: GroupedItemsField does not import shared.

## 4. Findings

### b17

1. **REQUIRED, one home per shape (SiteIoStatus).**
   - `shell/SiteVersionMenu.tsx:16-19` declares `interface SiteIoStatus`.
   - `panel/useCmsSiteOps.ts:18` exports the same interface; the catch commit added it.
   - Fix: delete lines 16-19 (and the blank line after them) in SiteVersionMenu.tsx, then add `import type { SiteIoStatus } from '../panel/useCmsSiteOps';` under the `cmsPanelTypes` import.
2. **REQUIRED, one home per shape (direct-chat binding).** `{ enabled: boolean; collectionIds: string[] }` appears three times:
   - `directchat/DirectChatView.tsx:10` `export interface DirectChatConfig`
   - `api/useGuardrailsData.ts:27` `export interface DirectChatBinding`
   - inline in `api/guardrailsApi.ts:91` `saveDirectChatGuardrails(...)`

   Fix:
   - Move `DirectChatBinding` (with its doc comment) into guardrailsApi.ts, the wire layer, above `GuardrailCapabilities`.
   - Type the parameter `saveDirectChatGuardrails({ enabled, collectionIds }: DirectChatBinding)`.
   - In useGuardrailsData.ts, delete lines 26-30 and import it with `import type { DirectChatBinding, GuardrailCapabilities } from './guardrailsApi';`.
   - In DirectChatView.tsx, delete lines 9-13 and add `import type { DirectChatBinding } from '../api/guardrailsApi';`. Replace `DirectChatConfig` with `DirectChatBinding` at lines 17-18. Nothing else imports `DirectChatConfig`.
3. **REQUIRED, contract rule "types never between JSDoc and function"** (same rule as S2 finding 5). In 13 files the component's JSDoc block now sits on the new Props interface, not on the function. In BASE the `*/` was directly followed by `export default function`. Each entry gives the type block that is now in between (file:lines):
   - controls/BackgroundControl.tsx:28-34
   - dialogs/AssetPickerDialog.tsx:20-37
   - inspector/AnalyticsInspector.tsx:65-76
   - inspector/DesignInspector.tsx:10-14
   - inspector/InspectorHost.tsx:33-44
   - navigator/NavigatorPanel.tsx:39-46
   - shell/CmsBuilderShell.tsx:95-109
   - shell/Dropdown.tsx:13-21
   - shell/LocaleMenu.tsx:17-31
   - shell/PublishMenu.tsx:58-69
   - shell/SaveBadge.tsx:9-13
   - shell/SiteVersionMenu.tsx:16-36
   - shell/TopBar.tsx:38-73

   Fix: in each file, move the type block (plus a blank line) above the `/**` that opens the component's doc, so that `*/` is again directly followed by `export default function`. This is comments and types only, so the gate stays identical.
   - Not affected: analyticsApi.ts:59, where the doc belongs to `AnalyticsResponse`, and ColorControl.tsx:30, where BASE had `const HEX_RE` after the doc, so the doc is a module header.
   - Found with: `awk 'prev ~ /^ *\*\/ *$/ && $0 ~ /^(export )?(interface|type) / {print FILENAME":"FNR} {prev=$0}'` over the changed .ts/.tsx files.
4. **Recommended, GuardStatus now has 3 homes.**
   - `useGuardrailsData.ts:21` is the new one: `{ configured: boolean; reachable: boolean }`. It is honest: `orgPrivacyShield.js:642-657` always sends both booleans.
   - It sits next to `orgShield/overview/types.ts:49` and `orgShield/parts/DetectionStatusPill.tsx:8`, both with optional fields.
   - Fix: export the required variant once from `overview/types.ts` (or guardrailsApi.ts) and import it. A required-field object stays assignable to the optional-field consumers. You can also leave this for an integrator follow-up, like OrgUser in S2.
5. **Recommended, `any` leak (accepted for this batch).**
   - `guardrailsApi.ts:20` `apiJson` has no return annotation. `let body = null; body = await res.json()` makes it `Promise<any>`, and every fetcher inherits that. `useGuardrailsData.ts:103` `.then((s: GuardStatus) => …)` is therefore an unchecked claim, though it is correct per the server route above.
   - A return type cannot be added now. `patterns/PatternSections.tsx:71-74,103-106` is already TS and consumes `apiJson`/`generateRegexWithAi` results as `any` (`data?.success`, a `.then((data: {...}) =>` annotation). A `Promise<unknown>` default would break that file.
   - Follow-up commit (types only, gate-identical):
     - Change the signature to `export async function apiJson<T = unknown>(path: string, options?: RequestInit): Promise<T>`, keeping the body as is.
     - Add type arguments at each fetcher, e.g. `apiJson<GuardStatus>(...)` and `apiJson<GuardrailOrg[]>(...)`.
     - In PatternSections.tsx, pass `apiJson<{ tiers?: Record<string, unknown> } | Record<string, unknown> | null>(...)` and a `GenerateRegexResponse` type.
   - The same applies to `MicrosoftIdentityPanel.tsx:26` `request` (it returns `res.json()`). The wire types `LinkRequest` and `SyncBinding` match `microsoftIdentityStore.listRequests` (`id, tenant_id, object_id, email, expires_at`) and the strict PUT `/microsoft/sync-binding` body.
6. **Nit, null-removing casts at a correlated guard (accepted).**
   - `ColorControl.tsx:150-151` `(parsed as ParsedOverlay)` sits behind `allowAlpha ?` at the same expression. `parsed` is `allowAlpha ? parseRgbaOverlay(value) : null`, and both are consts of this render. It is commented and fine.
   - `SectionThumb.tsx:187` `(SECTION_REGISTRY as Record<string, SectionComponent>)[type]` drops `undefined`. `<Comp>` is only rendered in the `!wireframeOnly` branch, and `wireframeOnly` includes `!registry[type]` (line 132), so the guard holds at the use site. It has no comment, unlike ColorControl. Fix: add above line 187 `// Rendered only when !wireframeOnly, which includes !SECTION_REGISTRY[type] (line 132).`
   - `primitives.tsx` PxSizeInput `(value as number)` is guarded by `Number.isFinite(value)` at the site. Fine.
7. **Nit, method bivariance.**
   - `ColorControl.tsx:126` `onChange(value: string | null): void` is a method on purpose, "so a `(v: string) => void` setter stays assignable". That switches off strictFunctionTypes for this prop.
   - At runtime it is true for the current TS callers: `ColorSwatch`/`ColorRow` (primitives.tsx:108/138) pass no `inheritFrom` and no `allowAlpha`, so they never receive null. `BackgroundControl` takes `string | null`.
   - Acceptable as documented. A later tightening would use property syntax and give `ColorSwatchProps.onChange`/`ColorRowProps.onChange` the `string | null` type.
8. **Nit, OrgEncryptionEditor `orgId: string` (honest as written, no change).**
   - The component guards `if (!orgId) return;` (line 63), but the only caller, `org/OrgInfoPanel.tsx:165`, passes `orgData?.id` after `if (!orgData) return` (line 84), so a string arrives.
   - Line 248 forwards it to `EncryptExistingData` (already TS, `orgId: string`), so it cannot become optional without a code change.
   - The guard also covers `''`. This is the IncidentCreateModal precedent from S2.
9. **Nit, security wire shapes match, no change.**
   - `EncryptionSettings`/`TierOption` match `orgRoutes.js:216-228` (`tier`, `entitled`, `tierOptions: availability.tiers`) and `encryptionAvailability.js:150-160`.
   - `TierOption.blockedBy` could be `'entitlement' | 'readiness' | null` (encryptionAvailability.js:135).
   - `GuardrailOrgShield` (all optional) matches the `/:orgId` default object, and `generateRegexWithAi` matches `regexGenerator.js:31-35`.
   - The save path still leaves Save disabled after a failed load (`setServer(null)`). Gate-identical, so no fail-open.
10. **Nit, lazy spellings.**
   - `panel/CreateFirstSite.tsx:8` `onCreate: (name: string) => Promise<unknown> | unknown` collapses to `unknown`. Write `(name: string) => unknown`.
   - `cmsApi.ts`: adding `: string` broke the column alignment of the `=>` arrows (lines 23-56). Cosmetic.
11. **Existing TS files touched: types only, both tighten.**
    - `cmsPanelTypes.ts:21-36` adds `CmsPageSeo` plus `seo?: CmsPageSeo` on `CmsPageDoc`, which narrows the `[key]: unknown` index. Correct per cmsBlog.js / SeoSection.
    - `panelView.ts:38/81` `coverageByLocale: Record<string, LocaleCoverage>` (was `unknown`).
    - **Recommended:** `CmsPageSeo` is identical to the private `CmsSeo` in `marketing/useCmsHead.ts:3`. Export it there and write `export type CmsPageSeo = CmsSeo;`, or the reverse.

### b16

12. **REQUIRED, mangled lines.** The tool that added types split one-line arrows and left the second half at column 1. eslint does not flag it. Join each pair back into the single line it was in BASE, with only the type added:
    - `CtaBannerEditor.tsx:39-40`: `const toggleSecondary = (next: boolean) => setField('secondaryCta',`
    - `CustomerSupportEditor.tsx:24-25`: `const setField = (key: string, value: unknown) => onChange(set(data, key, value));`
    - `FooterEditor.tsx:44-45`: `const updateLinkStyle = (patch: StyleBlob) => onChange(set(data, 'linkStyle', { ...linkStyle, ...patch }));`
    - `HeroEditor.tsx:60-61`: `const setMedia        = (patch: HeroMedia) => onChange(set(data, 'media',        { ...media,       ...patch }));`
    - `MediaTextEditor.tsx:73-74`: `const updateCta   = (key: string, value: unknown) => setField('cta',   { ...cta, [key]: value });`
    - `ReleaseNotesEditor.tsx:32-33`: `const setKind = (key: string, v: string) => onChange(set(data, 'kindLabels', { ...kindLabels, [key]: v }));`
    - `PricingEditor.tsx:88-89` (catch commit): `.catch(err => setPreview({ loading: false, error: messageOf(err, 'Failed'), plans: [] }));`

    Check afterwards: `grep -nE "^ [a-z,]|^,"` over `blockEditors/*.tsx` must return nothing.
13. **REQUIRED, one home per shape plus a wrong type (PricingEditor `PreviewPlan`).**
    - `PricingEditor.tsx:40-49` redeclares 7 fields of `PublicPlan` (`marketing/sections/PricingSection.tsx:13`) and types `price: number | null`.
    - The server sends `p.price ?? null` from a NUMERIC column (billing.js:45), and PublicPlan rightly says `number | string | null`.
    - Fix:
      - In PricingSection.tsx:13, change `interface PublicPlan` to `export interface PublicPlan`.
      - In PricingEditor.tsx, add `import type { PublicPlan } from '../../../../marketing/sections/PricingSection';` and replace lines 40-49 with:
        ```
        /** The fields of a `GET /api/billing/public-plans` plan that the preview list reads. */
        type PreviewPlan = Pick<PublicPlan, 'id' | 'name' | 'planType' | 'price' | 'currency' | 'billingInterval' | 'trialDays'>;
        ```
    - `price` only feeds `p.price != null` and a `TranslateParams` value (`Record<string, unknown>`, useTranslation.tsx:44), so it typechecks. The admin layer already imports from marketing (ContentEditor, blogPreview, SectionThumb).
14. **REQUIRED, the type leaves out the null the code writes (secondaryCta).**
    - Both editors write `null` when the toggle turns off (`CtaBannerEditor.tsx:41`, `CTAEditor.tsx:65`), but declare `secondaryCta?: CtaButtonValue` with the comment "Present only while … on".
    - **CtaBannerEditor.tsx:27-28:** change to `/** \`null\` (or absent) while the secondary CTA is off. */` and `secondaryCta?: CtaButtonValue | null;`. It compiles: the reads are `!!data.secondaryCta` and `data.secondaryCta || {}`.
    - **CTAEditor.tsx:19-20:** `| null` does NOT compile. I probed it in a standalone strict tsc file. Line 69 passes `data.secondaryCta` to `CtaButtonField value?: CtaButtonValue` behind `hasSecondary`. TS does not narrow that alias for a destructured parameter with a default, and `value = {}` does not cover null. Making it compile would take a code change, so keep the type and make the comment true: `/** \`null\` while off (the toggle writes null). Every read is behind \`hasSecondary = !!data.secondaryCta\`, which TS cannot correlate, so the type omits null. */`
15. **Recommended, one home per shape (block content).** These copies were introduced next to existing exported homes:
    - `blockEditors/shared.tsx:45` `SectionHeaderData` has the same 10 fields as `marketing/sections/sectionData.types.ts:14` `SectionHeaderFields`. Use `export type SectionHeaderData = SectionHeaderFields;` (import type).
    - `primitives.types.ts:43` `StyleBlob` is identical to `TextStyleInput` / `TextStyleBlob` (`marketing/sections/textStyle.ts:3`). d70ca8a3 turned it from `interface` into `type`, presumably for assignability to `Record<string, unknown>`. Try `export type StyleBlob = TextStyleBlob;`. If that alias of an interface breaks the typecheck, keep the local type and add a comment saying why.
    - The media slot is spelled 4 times: `MediaTextEditor.tsx:20` `MediaSlot`, `StepsEditor.tsx:12`, `FeaturesEditor.tsx:23` (inline) and `HeroEditor.tsx:22`. The `MediaSlot` in sectionData.types.ts:39 already covers all of them. Use `import type { MediaSlot } …` (Hero: `Pick<MediaSlot, 'src' | 'srcDark' | 'alt' | 'frame'>`).
    - The CTA shape is spelled 3 times:
      - `MediaTextEditor.tsx:30` `MediaTextCta` is exactly `CtaButtonValue`.
      - `HeroEditor.tsx:20` `HeroCta` and `LiveComponentEditor.tsx:26` `LiveCta` are both `CtaButtonValue & { enabled?: boolean }`. Export that once from `shared.tsx` (e.g. `ToggleableCta`) and use it in both.

    Run typecheck after these. They are types-only, and the duplication ratchet is green either way.
16. **Nit, AnalyticsResponse breadth (accept).**
    - `analyticsApi.ts:62-81` is one union of every route's fields with `data?: unknown`. That is honest for the single generic `analyticsFetch`, and it forces callers to narrow `data`.
    - Per-route types belong to `useAnalyticsQuery.js` and the sections when they convert. Leave a TODO there rather than here.
    - `SeriesPoint` (`window.ts`: `{x: unknown; y?: unknown}`) and `XYRow` (`ui.types.ts`: `{x?: string|null; y?: number}`) are two `{x,y}` shapes for different stages (raw versus breakdown). Fine.
17. **Nit, implicit any from `Array.isArray(unknown)`.** `analytics/ui.tsx:118, 131, 140` (`const arr: XYRow[] = Array.isArray(series) ? series : []`, and `.map((d: XYRow) …)` over `any[]`) claim the element type without a guard. This is the same pattern S2 accepted for `asArray` (nit 9 there). Reads like `d.y || 0` behave as in JS. Optional fix: a one-line comment above `toTimeseries`, e.g. `// Elements are Umami rows; every field read tolerates a missing value.`
18. **Nit.**
    - `catalogue.ts:42` `BlockCatalogueEntry` is not exported, while `panel/helpers.ts` maps `m.type`/`m.label` over it. Fine as is.
    - `blockThumbs.tsx` `Record<string, React.ReactElement>`. Fine.

## 5. Merge order
1. Fix commit on s2/batch-17: findings 1, 2 and 3, plus 6 (the comment) and 10 if wanted.
2. Rebase or replay s2/batch-16 on it.
3. Fix commit on s2/batch-16: findings 12, 13 and 14, plus 15 if wanted.
4. Merge s2/batch-16 into the integrator; it contains 17. Merge-tree against ccr-ccac4823-i270ro is clean today.
5. Afterwards run, on the combined tree:
   - `npm run typecheck` (agent-hub)
   - eslint on the touched files
   - `node scripts/duplication-ratchet.mjs`
   - vitest for `product-website` and `security`
   - `check:fast`

## Resolution (S2, fix commit 06fe267f on s2/batch-16; b17 not rebased, its fixes ride the b16 tip)
Required 1–3, 12–14 applied. Recommended: SectionThumb cast comment; `CmsPageSeo = CmsSeo` (exported from marketing/useCmsHead.ts).
GuardStatus left (four definitions, not identical). 0a7c0080 kept. Out-of-scope edits: `export` added to `PublicPlan`
(marketing/sections/PricingSection.tsx) and `CmsSeo` (marketing/useCmsHead.ts), types only.
Checks after the fix: `ts-equivalence s2/batch-17 HEAD` 27 identical, 1 different (PricingEditor catch);
`9c28ccea HEAD` 62 identical, 10 different of 72 (unchanged); transpile of the 28 touched files parent vs fix: 0 differences;
typecheck 0; eslint 0 errors; duplication 15372; vitest product-website/security/marketing sections 72 files / 779 tests pass.
Follow-ups for the integrator: generic `apiJson<T>` in guardrailsApi.ts (PatternSections.tsx depends on its any);
duplicate block-editor shapes (SectionHeaderData, StyleBlob/TextStyleBlob, media slot ×4, CTA ×3); GuardStatus ×4.
