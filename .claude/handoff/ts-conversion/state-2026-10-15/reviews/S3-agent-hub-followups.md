APPROVED: s3/lfa1, s3/lfa2, s3/lfa6, s3/lfa9 (every earlier finding is fixed; the items below are non-blocking). Merge test on e9cb7b18: the one typecheck error is a base break that comes from batch 18 and b2, not from these branches.

# S3 review of the agent-hub LF follow-ups (f7e31281, 45d38293, a05e6647, d1a14394 + 39e08627)

## Per branch

### s3/lfa1, f7e31281: APPROVED
- 1: `messageOf(opaqueErr, t('login.login_failed'))` follows the catch recipe exactly.
- 2: the `window.self` descriptor is saved and restored in afterEach. The pickup fetch is asserted as `[/^\/auth\/login-pickup\?id=/, { credentials: 'include' }]`.
- 3: the doc comment is fixed.
- The .tsx test keeps all 15 cases. Its assertions are equivalent: the three resetSignup field checks became one toMatchObject.
- No forbidden constructs. `{ preventDefault() {} } as FormEvent` is a test-only stub assertion; accepted.

### s3/lfa2, 45d38293: APPROVED (non-blocking items 1–3)
- saveInstructions and handleKnowledgeBaseIdsChange are byte-identical to b36ec171 TemplatesPage.jsx:255-280 (`{...prev}`, `err.message`).
- InputArea and ComplianceHub are now built in the .jsx pages, and both casts are gone. The InputArea props match base :669-679.
- New extractions, each checked against b36ec171:
  - `usePollersRef`: the ref and cleanup effect sit in the same slot, with the same body.
  - `useModelTiersLoader`: `templatesApi.chatModels()` resolves to `authFetch(\`${API_BASE}/ai/config/chat-models\`)` from the same `./mutate` module. The method (GET, no options) and the `.then(r => r.ok ? r.json() : {})`/`.catch(console.warn …)` chain are identical, and it runs in the same slot after the loadTemplates effect.
  - `useTemplateChatOptions`: the same useCallback×3, useMemo and useCallback calls, in the same order and with the same deps, evaluated before useChatEngine as the inline argument was.
  - `findActiveNavItem`: the same three-step `||` lookup.
- The page-level hook sequence is otherwise unchanged. useTranslation was already gone (accepted in the first review).
1. AdvancedSettings.jsx:171-178 builds `complianceHub` eagerly, and its `onBack` arrow names `setMobileDetail`, which is only declared at :191. This is fine at runtime (the arrow runs only on click), but it adds a new eslint warning, `react-hooks/immutability` "Cannot access variable before it is declared", which base did not have. Fix: build the element lazily inside `renderContent`, as base did: `const renderContent = () => renderSettingsContent({ …, complianceHub: <ComplianceHub … onBack={isMobile ? (() => setMobileDetail(false)) : null} />, … });`. This costs no extra lines.
2. AdvancedSettings.jsx: three rationale comments from base were cut to stay under 200 lines: base :300-305 (the badge's "a '0' invented while the endpoint has not answered is a lie"), :635-638 (onBack) and :704-709 (the 44px/844px title bar). The function is now 191 lines (92-282). Put back at least the "0 is a lie" and "two back buttons" sentences in compact form.
3. Leftovers from the first review's non-blocking list:
   - TemplatesPage.jsx:97-98 has a double blank line.
   - EmbedChat.stream.test.tsx:168 is still named "not JSON", but `sse()` JSON-encodes everything, so the test sends no non-JSON line.
   - There is no comment pointing to chat.js:570 at embedStreamEvents.ts.
   - The getParam `String(p)` change is still not declared.

### s3/lfa6, a05e6647: APPROVED (non-blocking item 4)
- palettes.test.ts now concatenates PageRenderer.jsx, pageLayoutElements.tsx and pageDataElements.tsx. It is green in the merged tree.
- mountEditorView: BeeEditor.jsx runs `useEffect(() => mountEditorView({...}), [])` with the original disable line and its reason, verbatim. It sits at base's position: after useEditorTableView and before the content, editable, placeholder and upload effects. eslint shows no exhaustive-deps warning on it. The body is verbatim from base :205-287, with no host guard. `uploadImage` is reached through a closure over the later `const`, called only after mount, as in base.
- mountAtom takes `node: AtomNode`, with no guard. The hover handlers use `(e.target as HTMLElement)`. beeEditorHandle.ts has one statement per line.
- PageRenderer:
  - chart: a non-array throws, null throws, `Number(d.value)`.
  - accordion: `accordionItem`, raw `item.title` and `item.content`.
  - table: `tableColumns` throws on a non-array.
  - dispatch: `typeof type === 'string'`.
  - **All 11 PageRenderer.test.tsx cases, plus the snapshot, pass against base b36ec171 PageRenderer.jsx.**
4. BeeEditor.jsx:44 passes `editable: props.editable ?? true`, where base had `const { editable = true } = props`, so a `null` now becomes `true`. No caller can pass null (`editable?: boolean`; RichTextEditor, PageEditor and NotebookEditorView all pass booleans). For exactness: pass `editable: props.editable`, and in mountEditorView.ts type it `editable?: boolean` and destructure `const { host, content, editable = true, s, sync } = deps;`.

### s3/lfa9, d1a14394 + 39e08627: APPROVED
- The stream test is now .ts. The fakes are typed and shared in voiceTestKit.ts, and the test duplication count is back at 26228.
- noPurple also scans hooks/appBuilderStream.
- The null-history case moved to the JS test and passes on base.
- `messageOf` at useVoiceSession.ts:192 is declared in the commit message.
- Two non-blocking notes:
  - voiceTestKit.ts:83 `impl as typeof authFetch` asserts a loosely typed fake to authFetch's type. It is test-only, documented, and the same category as the accepted `as unknown as Response` fakes.
  - The stream test's `speakOneTurn` now calls `connect({ agentId: 'agent-42' })` instead of `connect({})`. No assertion depends on it.

## Merge test (HEAD e9cb7b18, then lfa1, lfa2, lfa6 and lfa9 merged one by one)
- All four merges were automatic ('ort'), with no conflicts.
- check:fast: 39/39 ✅.
- duplication: production 15276/15383 ✅, test 26228/26228 (at budget) ✅.
- long-function: agent-hub 257 ✅, server 104 ✅.
- ts-ratchet: 2178 JS files, equal to e9cb7b18 (no new .js or .jsx) ✅.
- lint:editor-bundles: both bundles up to date ✅.
- lint:dead (knip): clean ✅.
- vitest of pages, editor, renderers, chat/Voice, hooks, admin/subscriptions and admin/security: 372 files, 4202 tests ✅.
- mobile jest of src/shared/markdown and src/features/org: 69 suites, 661 tests ✅. This includes palettes and sections.lockstep.
- Source-reading tests in mobile and server: only palettes.test.ts and sections.lockstep.test.ts name a changed file (both green). server/utils/text.test.js and routes/reports.test.js mention BeeEditor and PageRenderer only in comments.
- agent-hub full typecheck: **1 error, NOT from these branches.** `src/components/admin/subscriptions/hooks/useApi.ts:18`: `RequestInit` is not assignable to `AuthFetchOptions`. The file was converted in batch 18 (cc002b55), which is untouched by lfa*, and this is how it interacts with b2's new `AuthFetchOptions`. Fix in the base: `import type { AuthFetchOptions } from '../../../../utils/helpers'` and type `opts?: AuthFetchOptions` on both `api` and `apiJson`. (The main checkout already shows an uncommitted edit to this file.)
- Base check: every new or changed test (LoginPage.signup, TemplatesPage, EmbedChat stream and chatSignals, both voice tests, PageRenderer) run against the b36ec171 sources: 7 files, 87 tests ✅.
- The scratch worktrees have been removed.

## Resolution (integrator S3)
- lfa2 1-3: fixed in a0710f3c (ComplianceHub built lazily in renderContent; "0 is a lie" rationale restored — "two back buttons" was already kept at hideTitleBar; double blank line removed; the embed stream test now sends a real malformed `data: {not json` line, which base EmbedChat.jsx:218 also swallows in its try/catch). Remaining small notes (comment pointing to chat.js:570, getParam String(p)) left as is.
- lfa6 4: fixed in 06d97c5a (`editable: props.editable`; mountEditorView `editable?: boolean` with `editable = true` default, exactly base's destructuring default).
- Both: eslint 0 errors, agent-hub typecheck 0 errors, vitest (pages 170, editor 782) pass.
- The one typecheck error in the merge test (subscriptions useApi.ts RequestInit vs b2's AuthFetchOptions) was fixed on the integration branch before (types only, emitted JS identical).
