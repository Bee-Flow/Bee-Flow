# Reading a caught error in TypeScript (recipe for JS to TS conversion)

In a `.ts`/`.tsx` file `catch (e)` is `unknown`. Do not write `catch (e: any)` and do not cast
(`(e as Error).message`). Import the helpers from `agent-hub/src/utils/caughtError.ts` (relative
path) and replace each read as below. The helpers do the same property read as the JS, do not
throw for null/undefined, and return a narrowed type.

Helpers: `errorMessage(e): string|undefined`, `messageOf(e, fb): string`, `describeError(e): string`,
`errorStatus(e): number|undefined`, `errorCode(e): string|undefined`, `errorName(e): string|undefined`,
`errorBody(e): unknown`, `errorBodyRecord(e): Record<string, unknown>|undefined`, `isAbortError(e): boolean`.

## The one rule: token substitution only

Replace the property read, nothing around it. Allowed substitutions (V is the catch variable):

| JS token | TS token |
|---|---|
| `V.message`, `V?.message` | `errorMessage(V)` |
| `V.message \|\| '<string literal or t(...) call>'` (or `V?.message \|\| ...`) | `messageOf(V, '<same>')` |
| `V.status`, `V?.status` | `errorStatus(V)` |
| `V.code`, `V?.code`, `V && V.code` | `errorCode(V)` |
| `V.body?.k`, `V.body.k`, `V?.body?.k`, `V && V.body && V.body.k` | `errorBodyRecord(V)?.k` (narrow `k`: it is `unknown`) |
| `...(V.body \|\| {})` | `...(errorBodyRecord(V) ?? {})` |
| `V.body` used whole (may be a string) | `errorBody(V)`, then narrow |
| `V.name === 'AbortError'`, `V?.name !== 'AbortError'` | `isAbortError(V)` / `!isAbortError(V)` |
| `V?.name \|\| 'Error'` (logging) | `errorName(V) \|\| 'Error'` |
| `String(V?.message \|\| V)` | `describeError(V)` |

Anything else (a changed setter type, a new fallback, restructured control flow) goes under a
`// behaviour:` note in the commit message.

When the fallback is NOT a plain string expression, replace only the token and keep the rest:
`V.message || V` becomes `errorMessage(V) || String(V)` (inside String: `String(errorMessage(V) || V || 'fb')`);
`V.message || V.managed.message` becomes `errorMessage(V) || <managed part, narrowed as it was>`;
`V.message || listErrorText`, `|| GENERIC_LOAD_ERROR`, `|| someFn()` stay `errorMessage(V) || <unchanged>`.
`messageOf` evaluates its fallback eagerly: never pass one with side effects or cost.
Sites to hand-check: ColumnDesigner.jsx:155 (`|| e.managed.message`), builderSplitActions.js:171,
useAgentAutosave.js:110, buildWebpagePreview.js:176.

Examples:

```ts
toast.error(e?.message || t('k', 'Could not save'));   ->  toast.error(messageOf(e, t('k', 'Could not save')));
setError(e.message);                                    ->  setError(errorMessage(e));
if (e.status === 402 || e.code === 'cap') x();         ->  if (errorStatus(e) === 402 || errorCode(e) === 'cap') x();
if (e && e.code === 'cap') x();                         ->  if (errorCode(e) === 'cap') x();
if (e?.name === 'AbortError') return;                   ->  if (isAbortError(e)) return;
const rec = e.body?.record;                             ->  const rec = errorBodyRecord(e)?.record;
return { ok: false, invalid: true, ...(e.body || {}) }; ->  ... ...(errorBodyRecord(e) ?? {})
console.warn('x', e?.name || 'Error');                  ->  console.warn('x', errorName(e) || 'Error');
`failed: ${e.message}`   /  'failed: ' + e.message      ->  `failed: ${errorMessage(e)}`  (prints "undefined" as before; do not fix here)
```

Plain `setError(e.message)`: type the state as what the JS stored, `useState<string | null | undefined>(null)`,
and pass `errorMessage(e)` unchanged. Use `messageOf` only if the target must be a string, and say
so in the commit (`// behaviour: shows the fallback instead of nothing`).

## Callers that pass or store the caught value

- 15a. `e` passed to a callee that takes `unknown`, `console.*(e)`, `throw e`: unchanged.
- 15b. State or callback that stores the caught value: type it `unknown` (`useState<unknown>(null)`,
  `onError?: (e: unknown) => void`); every read of it, also in consumers in other files, uses the
  helpers. `git grep` the consumers before finishing. Known sites: useExecutions.js:146,
  useFormDetail.js:45/72, usePlaybook.js:40/109, useApi.js:45, useGuardrailsData.js:57,
  useAudioRecorder.js:141, useTranscription.js:42, ExecutionView.jsx:58, AiActLadderModal.jsx:214/228.
  If the consumer is a file you are not converting, leave `// TODO(err-unknown)` and tell the coordinator.
- 15c. A TS callee with a narrow parameter type (routeRulesRequest.ts `askFailureMessage`): widen
  the parameter to `unknown` and read it with `errorStatus`/`errorMessage`. No cast at the call site.
- 15d. A JS callee with a TS type shim (typedViews.ts `sourceErrorMessage ... as unknown as`): give it a
  real `(t, err: unknown, ...)` signature and delete the shim in the same commit.

## Do NOT rewrite mechanically

1. `.name` reads other than `=== 'AbortError'` and the `|| 'Error'` log (they are not covered).
2. `e.formatted || e.message || String(e)`; `e.retryAfter`, `e.managed`, `e.unreadable`, `e.field`:
   narrow with `instanceof` of the concrete class or a local type guard. No cast.
3. Errors stored in state and read in another file: convert both sides together or `// TODO(err-unknown)`.
4. Message-as-code: `e.message === 'missing'`, `.includes(...)`, `.startsWith(...)` (RolesManager.jsx:262,
   NewFormDialog.jsx:59): use `errorMessage(e) === 'missing'`, `(errorMessage(e) ?? '').includes(..)`,
   and keep the string contract; do not "improve" it to codes.
5. `e instanceof SomeError` branches: keep them. Note `rowBrowserModel.ts` exports an `interface ApiError`
   that is NOT the class in `api/client.ts`: never use it for `instanceof` or as a cast.
6. `api/queries/skills.ts` private `messageOf` (reads `body.error` of an `ApiError`): different semantics;
   do not swap it for the shared one.
7. A change the user can see (a string-only setter now showing a fallback) without a `// behaviour:` note.
8. `.catch((e) => ...)` callbacks and variables not named e/err/error: same helpers, but re-read by hand.
9. Tests that assert a throw on `e.message` of null: leave.
10. `catch (e: any)`, `e as Error`, `e as ApiError`, `as unknown as`: never.
11. Do not import helpers you do not use (lint, knip). Unused binding: `catch {`, keep the empty-catch comment.

## Finding the sites (reproducible)

Run from `agent-hub` (counts depend on the commit; this recipe was written at 44072b7db):

```
git grep -nE 'catch \((e|err|error)\)' -- 'src/*.js' 'src/*.jsx'                    # catch blocks (508 lines)
git grep -nE '\b(e|err|error)\??\.message\s*\|\|' -- 'src/*.js' 'src/*.jsx'        # messageOf candidates
git grep -nE '\b(e|err|error)\??\.message\b' -- 'src/*.js' 'src/*.jsx'             # all message reads
git grep -nE '\b(e|err|error)\??\.status\b' -- 'src/*.js' 'src/*.jsx'              # errorStatus
git grep -nE '\b(e|err|error)\??\.code\b' -- 'src/*.js' 'src/*.jsx'                # errorCode (also finds non-catch e)
git grep -nE '\b(e|err|error)\??\.body\b' -- 'src/*.js' 'src/*.jsx'                # errorBodyRecord / errorBody
git grep -nE '\b(e|err|error)\??\.name\b' -- 'src/*.js' 'src/*.jsx'                # isAbortError / errorName
```

Those greps match any variable named e/err/error, not only catch variables; judge each hit in its block.
Measured at 44072b7db by scanning each catch block body: 508 blocks in 226 files; `message` is read in
about 300 of them, most often as `e.message` or `e.message || fallback`; `status`/`code`/`body`/`name`
reads are each in 8 to 20 blocks.
