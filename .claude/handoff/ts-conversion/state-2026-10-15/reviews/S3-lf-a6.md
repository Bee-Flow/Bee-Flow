CHANGES REQUIRED: a mobile test that reads PageRenderer.jsx by path now fails 17 of its 35 cases, the BeeEditor mount effect lost its react-hooks lint coverage against the drafter-brief rule, and PageRenderer has 5 undeclared behaviour changes on malformed input. The BeeEditor hook order and dependency arrays are identical to base.

# Opus review S3 LF-A6 (s3/lfa6 = 53aa4eea, df0b1164, dfedab40 on b36ec171)

## Blocking

1. **A mobile test that reads source by path is red.** mobile/src/shared/markdown/renderers/rich/palettes.test.ts:18 reads `web('PageRenderer.jsx')` and expects to find the button, stat and badge palettes, the card accent gradient and `element.change > 0 ? …`. All of these moved to pageDataElements.tsx and pageLayoutElements.tsx. Result: branch has 17 failed of 35; base passes 35 of 35 (jest via heavy.sh).
   Fix: `const PAGE = web('PageRenderer.jsx') + web('pageLayoutElements.tsx') + web('pageDataElements.tsx');` and update the header comment. Then run `cd mobile && heavy.sh ./node_modules/.bin/jest src/shared/markdown/renderers/rich/palettes.test.ts`.

2. **The react-hooks-disabled mount effect moved into TS, and its disable comment was removed** (useEditorViewLifecycle.ts:36-120; base BeeEditor.jsx:204-287 with `// eslint-disable-next-line react-hooks/exhaustive-deps`).
   - agent-hub/eslint.config.js:179-193 applies only the size and complexity rules to `**/*.{ts,tsx}`. So for every moved hook, react-hooks is gone entirely, including rules-of-hooks.
   - I ran eslint once with react-hooks turned on for the five new hook files: 21 exhaustive-deps warnings. Almost all of them name only refs and setters that come through the `s` bag. The mount effect is the exception: it omits real values (`content`, `editable`, `uploadImage`), which is exactly what the old disable was there to document.
   - drafter-brief.md:14 says such code stays JavaScript.
   - Fix: export a plain function `mountEditorView(deps): () => void` from useEditorViewLifecycle.ts containing the effect body unchanged (no `if (!host)` guard, see 4). Call it from BeeEditor.jsx at the same hook position, between `useEditorTableView` and the rest of the lifecycle hook: `useEffect(() => mountEditorView({ host: s.hostRef.current, content: props.content, editable: props.editable ?? true, s, sync, uploadImage: (f) => uploadImageRef.current(f) }), []);` with the original eslint-disable line and its reason restored above the `[]`.
   - The new hook then holds only the content, editable, placeholder and upload effects. Keep `uploadImage` reachable the way base did (a closure over a later-declared binding, or a ref).

3. **PageRenderer: undeclared behaviour changes.** I proved these with a differential vitest of the same cases on base and branch.

   | input | base | branch |
   |---|---|---|
   | chart `data: {…}` or `'abc'` | throws TypeError | empty chart |
   | chart `data: [null, …]` | throws | null item skipped |
   | chart `data: [5, …]` | renders an empty row | row dropped |
   | accordion `title`/`content` arrays | rendered ("Tx", "ab") | dropped (`asNode`) |
   | accordion `content: true` | children not shown | children shown |
   | accordion item `null`, or an object as title | throws | renders empty |
   | table `columns: 3` | throws | empty header |
   | `type: ['page']` | default branch | page renderer (`Object.hasOwn` coerces the array key) |

   None of these needs a forbidden construct. Fixes:
   - pageDataElements.tsx:456: `const raw = element.data || []; if (!Array.isArray(raw)) throw new TypeError('chart data is not an array');`. Map the items with `function datum(v: unknown): Partial<ChartDatum> { if (v == null) throw new TypeError(\`Cannot read properties of ${v} (reading 'value')\`); return typeof v === 'object' ? v : {}; }`, use `Number(d.value)` in `Math.max` and in the width (same NaN and coercion as base), and drop `isChartDatum`.
   - pageDataElements.tsx:291-315: remove `asNode` and the `{}` fallback. Use `function accordionItem(v: unknown): PageAccordionItem { if (v == null) throw new TypeError(\`Cannot read properties of ${v} (reading 'title')\`); return typeof v === 'object' ? v : {}; }` and render `{item.title}` and `{item.content || (item.children && …)}` exactly as base.
   - pageDataElements.tsx:340: `const cols = element.columns || []; if (!Array.isArray(cols)) throw new TypeError('table columns is not an array');`.
   - pageElementRenderers.tsx:42: `typeof element.type === 'string' && Object.hasOwn(RENDERERS, element.type)`.
   - Add these cases to PageRenderer.test.jsx and check that they pass against base PageRenderer.jsx (the throws as `expect(() => render(…)).toThrow()`).

4. **Declared deltas that can be avoided.** Restore all three:
   - Button hover (pageDataElements.tsx:247-248) uses `currentTarget`; base used `target`. drafter-brief.md:11 allows a direct assertion, so restore with `(e.target as HTMLElement).style.transform = …`.
   - Host null guard (useEditorViewLifecycle.ts:39). Base let `new EditorView(null)` and `addEventListener` throw. This goes away with fix 2, because the guard is not needed in JS or behind a `host: HTMLElement` parameter.
   - `if (node)` in `mountAtom` (useEditorViewLifecycle.ts:49) was not declared. Type the parameter as `node: AtomNode`, which is non-optional; render.js:177 always passes a node. Then drop the guard.

## Non-blocking

5. The new BeeEditor.jsx:41 warning `useImperativeHandle … missing dependencies: 's' and 'sync'` does not change behaviour. Base deps were `[refreshChrome]`, and `sync.refreshChrome` is the same `useCallback([])` value, so the handle is built once in both versions. `buildEditorHandle` reads only refs, setters and `refreshChrome`, all of which are stable. It is a lint artefact of the `s`/`sync` bags, and lint:budget stays green (5414/6674). If the integrator wants it gone without an eslint-disable, destructure the stable refs and setters it needs in BeeEditor.jsx and pass them explicitly. Do not add `s` or `sync` to the deps: that rebuilds the handle on every render.
6. beeEditorHandle.ts:399 `if (canRebase(view))` is always true at runtime (view.js:1051). It is a runtime guard that exists only to type `rebase`. Acceptable. Cleaner: a JSDoc `@param` on `EditorView.replaceDoc`.
7. Other smaller differences, all equivalent in practice:
   - beeEditorHandle.ts:379 and :381 put two statements on one line (drafter-brief.md:13). Split them.
   - `aiAction` (useEditorInteractions.ts:276) dropped base's `view.getText &&` check; `getText` always exists (view.js:1129).
   - `String(…href || '')` in the link bubble (BeeEditorView.tsx:177).
   - `errorName(e) || 'Error'` follows the catch recipe.
8. PageOverlay now calls `useTranslation()` itself instead of taking `t` from its parent. This is fine.

## Checked and OK

- **BeeEditor hook order.** The order is identical, base vs new:
  - useTranslation, then 4 refs and state, …, collapsed, hiddenHeaders (useBeeEditorState)
  - effect `[]`-less, the notebookId effect, onTocRef plus its effect, onWordCountRef plus its effect, applyWordCount, useEditorChrome, chromeRef, useEditorCollab(viewInst, collabHandle), collabRef, editableRef, useEditorAnchors, anchorsRef, refreshChrome (useEditorSync)
  - prevNbRef, 4 effects, toggleCollapseFocused, openChartModal, createChart (useEditorTableView)
  - mount `[]`, content `[content, refreshChrome, collab.bound]`, setEditable `[effectiveEditable, viewInst]`, placeholder `[placeholder, t]`, uploadImage `[]`, uploadError effect (useEditorViewLifecycle)
  - useImperativeHandle
  - toggleHeadersFocused, the link callbacks, insertItems/toolbarInsertItems memos, runInsert, slash state, detectSlash, the selectionchange effect, runSlash (useEditorInteractions)

  Every dependency array is identical. useEditorCollab gets the same arguments at the same position, and the Yjs code is untouched. The mount effect body and its cleanup order (remove paste, drop and keydown listeners, clear the save timer, destroy the view, clear the host, `setAtoms([])`, null the refs, `setViewInst(null)`) are verbatim apart from the two guards above. No stale-closure change: every value read later goes through the same refs as in base.
- **PageRenderer dispatch.** The handler map has the same 19 cases as base's switch (page, grid, row/columns, section, card, heading, text/paragraph, image, list, divider, button, tabs, accordion, table, stat, badge, chart), and the default branch is the same. The DOM snapshot was recorded on base: PageRenderer.test.jsx and its .snap pass (4/4) against base PageRenderer.jsx in a scratch worktree.

## Gates (in a scratch worktree of s3/lfa6)

- agent-hub `npm run typecheck`: 0 errors ✅
- eslint on the changed files: 0 errors, 7 warnings (6 size, plus #5) ✅
- vitest src/editor + src/components/renderers: 63 files, 797 tests ✅
- `lint:dead` (knip) ✅
- `check:fast`: 39/39 ✅
- `lint:editor-bundles`: both bundles up to date ✅
- long-function agent-hub: **266** ✅
- duplication: production 15423, so **Δ0** vs base's 15423 (still over the 15419 budget from prep2); test 26228/26279 ✅
- `lint:budget`: agent-hub 5414/6674, server 0 ✅
- mobile palettes.test.ts: **17 failed** ❌ (see 1)

## Merge test

Scratch worktree at HEAD d9f6070a (claude/batch-18-lf-s7-server-me5ppc), then `git merge --no-edit s3/lfa6`: clean, no conflicts. agent-hub typecheck on the merged tree: 0 errors. All scratch worktrees have been removed.
