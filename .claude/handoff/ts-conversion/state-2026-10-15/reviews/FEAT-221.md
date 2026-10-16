# Review FEAT #221 (Opus, read-only)

Branch `ts-bugs/feat-G1`, range `origin/ts-bugs/fixes..HEAD` (7 commits).

## Verdicts

| Commit | Subject | Verdict |
|--------|---------|---------|
| e08d75ae9 | server side of the design controls | APPROVE with findings 2, 5, 6 |
| 5369b345a | convert Features to TypeScript | APPROVE |
| 671e3d72e | convert DesignEditor to TypeScript | APPROVE (see note on bisectability) |
| 1f9e707de | convert TranslationPanel to TypeScript | CHANGES REQUIRED (finding 4) |
| ea206cff6 | render and edit the design controls | APPROVE with finding 7 |
| f11432470 | per-language media in the translation panel | CHANGES REQUIRED (findings 1, 3, 8) |
| d3e6d779d | rebase fix (types, ratchet, Dutch catalogue) | APPROVE |

## REQUIRED findings

1. **`server/routes/cmsPageHandlers.js:193`, `server/routes/cmsSiteHandlers.js:76`, medium.**
   The admin PUT locale routes sanitise (through `setPageLocaleOverride` / `setSiteLocaleOverride`), but they throw away
   the sanitised result and answer `{ success: true }`. A translator types an address in the new media row, the panel and
   the preview keep showing it, and the server has silently dropped it (the public page shows the default-language
   media). The MCP path reports this with `mediaWarning`. The admin path should report it too.
   Fix: return the same `mediaWarning` (or the sanitised override) from both routes, and have the panel show it. Put
   `countMediaRefs` in `stores/cms/localeMedia.js` so both callers share it.

2. **`server/cms/mcp/siteHandlers.js:33`, low.** `MEDIA_KEYS` is a second copy of the list that `localeMedia.js`
   exports. Fix: import `MEDIA_KEYS` from `../../stores/cms/localeMedia` (see finding 1 for moving `countMediaRefs`).

3. **`f11432470` commit message: `Closes #221`, medium (process).** The issue has a later comment (2026-10-16) with four
   more open gaps: the dark band colour, the hero blur blobs, the trust-band label style, and `cardFill`. None of them are
   addressed here. Merging with `Closes` would close the issue with those items still open.
   Fix: change it to `Refs #221` (on the squash/PR description), or move the comment's items into a new issue first.

4. **`agent-hub/src/components/admin/product-website/TranslationPanel.tsx:52,54`, low (TS honesty).**
   `onSelectBlock?(blockId?: string)` and `onClearAndRetranslateBlock?(blockId?: string)` use method syntax so the
   bivariance check lets a `(blockId: string) => void` through. That is the unsoundness the comment describes, made
   quiet rather than fixed. Fix: type them `(blockId: string) => void` and capture a narrowed `const blockId = g.blockId`
   before the closures that call them.

5. **`agent-hub/src/components/admin/product-website/translatable.ts:168,179,202` (and the site rows), low
   (TS honesty).** `getLocalePath(...) as string | undefined` asserts a type that stored data does not guarantee: an
   override can hold a non-string at that path. Fix: add a small `asText(v: unknown): string | undefined`
   (`typeof v === 'string' ? v : undefined`) and use it instead of the cast.

6. **`agent-hub/src/components/admin/product-website/translatable.ts:21`, low (crammed line).** The
   `TranslatableRow` interface is six fields plus a doc comment on one line of about 240 characters. Fix: one field per
   line, with the doc comment above `media`.

7. **`agent-hub/src/marketing/blockWrap.ts:41-47`, low.** `DISPLAY_TRACKING_EM[name]` reads from a plain object
   literal, so names such as `constructor` or `toString` resolve to `Object.prototype` members. This is not an injection
   (the value is not the stored string, and `setProperty` rejects it), but the `Record<string, string | undefined>`
   type claims something the object does not do. Fix: `Object.hasOwn(DISPLAY_TRACKING_EM, name) ? … : undefined`, or
   build it with `Object.create(null)` / a `Map`.

8. **`agent-hub/src/components/admin/product-website/translatable.ts:97`, low.** `isMediaPath` is exported but
   nothing uses it (not even a test). Fix: remove it, or use it in the panel instead of the `media` flag.

## Advisory (not blocking)

- `server/cmsBuilder/validate.js:37`: a second `// @typecheck` was added. Line 1 already carries one. Remove the
  duplicate.
- `agent-hub/src/marketing/designTypography.ts:14` and `DesignEditor.tsx:199` hard-code `[500, 600, 700, 800, 900]`.
  The DisplayTracking options and the `validate.js` warning hint also restate the enums. `HEADING_WEIGHTS` and
  `DISPLAY_TRACKINGS` are already mirrored in `blockData.generated.mjs`, so import them from there and keep a single
  source.
- `server/stores/cms/localeMedia.js:39` accepts any single-slash site path, while the MCP tool text and `mediaWarning`
  say "/api/cms/asset/… paths". `server/stores/cms/stories.js:68` (`mediaRef`) is a second, stricter media-address
  validator, and `stories.js` `localizeBlocks` does not apply the new media merge. Either restrict localeMedia to the
  asset route or describe it as "a site path", and consider one shared validator.
- The "only untranslated" filter in the translation panel still lists the empty media rows, although they are no
  longer counted as missing.
- "Clear this block's translations and let AI retranslate" removes the block's media overrides as well. AI translate
  does not bring them back (by design), so the button's hint should say so.
- `e08d75ae9` carries the pure renames `Features.jsx -> .tsx` and `DesignEditor.jsx -> .tsx` (0 changed lines). The
  conversion commits then add the types. `671e3d72e` imports `EditableDesign`, which `ProductWebsite.types.ts` gains
  only in `d3e6d779d`, so the commits in between do not typecheck on their own. This is fine if the branch is squashed.
- `localeMedia.js` is tested from `cmsBuilder/cmsDesignControls.test.js`. It is not tested next to the source, and
  `mediaWarning` itself has no test.

## What I checked and found fine

- **TS equivalence.** `node scripts/ts-equivalence.mjs e08d75ae9~1 1f9e707de --diff`: 3 identical, 0 different of 3
  converted files. The requested `origin/ts-bugs/fixes HEAD` form reports 3 different, but only because the feature
  commits ea206cff6 and f11432470 later change the same files (mediaBoxClass, counted rows). The conversions themselves
  are type-only.
- **CSS injection.** Every new style value goes through `sanitizeBlockDesignStyle` / `validateStylePatch` (enum members
  or booleans). `backgroundSize` is an enum member or `^\d{2,4}px$`, clamped to 16-2400 and rebuilt from the number. The
  renderer (`blockWrap.ts`) emits only class names plus one custom property, `--cms-bg-size: <n>px auto`, rebuilt from
  that number. `mediaHeight` / `mediaFit` become classes only after an `includes` check. `displayTracking` maps to fixed
  em values. `headingWeight` is checked against the list. Illegal values are dropped on every page save (`setPage` ->
  `normalizeBlockRecord`, so the admin PUT page and the MCP/builder paths both go through it). The draft validator warns
  about them.
- **Per-language media.** `safeMediaRef` rejects `javascript:`, `data:`, protocol-relative URLs, `..` segments, quotes,
  angle brackets, whitespace and control characters. It allows only `cms/` keys (restricted charset), single-slash site
  paths, and http(s) URLs with a host. Overrides are cleaned on write (`sanitizePageOverride` / `sanitizeSiteOverride`,
  which every writer uses: admin routes, MCP, AI-translate save, import/duplicate, page removal) and again on read in
  `resolveEffective`, so a value written around the setter is dropped too (covered by a test). A media key never
  creates structure the default does not have.
- **AI translate.** The server and client `DENY_KEYS` cover `src`, `srcDark` and `poster`; `captionsSrc` is caught by
  the `Src$` suffix. AI translate starts from the existing override, so manual media overrides survive. Media rows are
  excluded from coverage and the group counts.
- **Mirror.** The manifest entry is correct (`cjs-to-esm`, with a reason). `npm run lint:shared-mirror` exits 0, and
  `blockStyleEnums.generated.mjs` matches its source. The lockstep test passes.
- **i18n.** `npm run lint:i18n-gen` is up to date. All 48 new `cms_site` keys are in the owning NL catalogue
  (`hardcoded-website-admin-2026-10-nl.json`), with matching placeholders. `DATA_SHA256` is bumped, so installs that
  already ran the migration re-run it. All 80 `cms_site.*` keys used by the new controls exist in `GUI_DEFAULTS`.
- **Motif CSS.** The motif overrides every inset of the glow pseudo it shares, sits under the content (z-index 0/1,
  `isolation: isolate`), and uses existing tokens (`--hex-pattern`, `--brand-primary`, `--brand-accent`). Hide-on-mobile
  correctly needs `!important` against the inline image.
- **Server typecheck.** No errors. The new files carry `// @typecheck`.
- **Tests, run one at a time.** Server: `cmsBuilder/cmsDesignControls.test.js` 11/11,
  `cmsBuilder/builderTools.test.js` 37/37, `migrations/add-nl-hardcoded-website-admin-2026-10-translations.test.js` 5/5.
  Agent-hub (vitest, `--maxWorkers=2`): `blockWrap.test.ts` 5/5, `blockStyleEnums.lockstep.test.ts` 2/2,
  `translatable.test.ts` 11/11.
