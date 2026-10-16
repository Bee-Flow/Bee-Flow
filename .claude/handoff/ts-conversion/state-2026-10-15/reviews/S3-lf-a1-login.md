APPROVED

# S3 lf-a1: LoginPage split (s3/lfa1 f082e8d9 on b36ec171), security review

Reviewer: Opus, read-only. Original `LoginPage.jsx@b36ec171` compared side by side with every new file.

## Gates (scratch worktrees, removed afterwards)
- agent-hub `npm run typecheck` (full, heavy.sh): rc 0.
- `npx eslint` on the 15 changed files: 0 errors, 13 warnings (complexity/length only); `lint:budget` green inside check:fast.
- vitest `src/pages/LoginPage* src/pages/login` at head: 11 files, 233 tests pass.
- `LoginPage.signup.test.jsx` copied onto the ORIGINAL LoginPage.jsx (b36ec171): all 4 LoginPage*.test files, 108 tests pass. It is a true characterisation test.
- Existing LoginPage.test / .recovery / .e2eSelectors tests: untouched in the diff, pass at head.
- `npm run lint:dead` (knip): clean. `npm run check:fast`: 39 passed, 0 failed.
- `count-ratchet long-function agent-hub`: 268 (budget 270). `duplication-ratchet`: production 15392/15419, test 26270/26279.

## Checklist results
1. authFetch calls (setup-status, organizations/public, billing/public-plans with signal, pending-invite, invite/:token, auth/user, setup, admin-login, mfa/verify-login, forgot-password, reset-password, signup, resend-verification) and the raw `fetch` login-pickup with `credentials: 'include'`: URL, method, headers, body fields byte-identical (`loginRequests.ts`). Status branches, error strings and fallbacks are identical. `setSessionToken` is the only token write, same place. No new logging (the two `console.error`s are the originals). Secrets are read per call from component state; nothing in module scope, no new refs; the polling interval closure holds pickupId + onLogin only, as before.
2. OPAQUE → mfaRequired → emailVerificationRequired → success → error order identical; security-key code list identical; no new account-existence signal (forgot/resend stay neutral). Declared changes:
   - `errorMessage(opaqueErr)`: identical to `opaqueErr.message` for every value except a null/undefined rejection (original: TypeError inside the catch → `login.connection_error`; now `login.login_failed`). `opaqueLogin` only throws `Error`s, and the catch recipe sanctions this substitution. Not user-visible in practice; accepted.
   - `endMfaWith(data.error ?? '')`: state '' instead of undefined; `error` is only read for truthiness (LoginNotices) and the signup wizard is not on screen in the MFA step. Not visible; accepted.
   - `setError(v.error ?? '')`: `validateSubmit` always sets `error` when `ok` is false (signupValidation.ts:189-219). Unreachable; accepted.
3. OAuth: no postMessage listener before or after (noopener popup, pickup poll). Interval/timeout/unmount cleanup at the same moments; the added `if (pollTimerRef.current)` guards before `clearInterval` are no-ops. Redirect targets (`${serverUrl||API_BASE}/auth/login/{nextcloud,google,microsoft}`) unchanged; no redirect-after-login parameter exists in either version.
4. URL-param effects: same parsing, same `replaceState` calls, same deps (`[]`, `[t]`, `[t]`, `[t]`, `[]`), same order. Handlers are re-created per render as before, so no new stale closures; `openOAuthPopup` keeps `useCallback([onLogin])`.
5. Effect/memo order, original: plans effect, memo, memo, setup-status effect, reset, verified, sso-error, invite-error, invite, ref, callback, cleanup effect. New: identical (useSignupPlans → useAuthSettings → useLoginUrlParams ×4 → useInviteToken → useOAuthPopup). The useState calls moved into hooks (order of state slots differs), which has no runtime effect. No conditional hooks. Testids and i18n keys unchanged.

## Findings (non-blocking)
1. `agent-hub/src/pages/login/useLoginActions.ts:89`: the catch recipe's table maps `V.message || t(...)` to `messageOf(V, t('login.login_failed'))`. Same behaviour; use it for recipe conformance when next touching the file.
2. `agent-hub/src/pages/LoginPage.signup.test.jsx:230,257`: `window.self` is redefined in the test body and only deleted on success. Move the restore into the describe's `afterEach` (save the descriptor with `Object.getOwnPropertyDescriptor(window, 'self')` and put it back) so a failing assertion cannot leak it. Optionally also assert `credentials: 'include'` on the pickup fetch (`fetchMock.mock.calls[0][1]`).
3. `agent-hub/src/pages/login/useSignupPlans.ts:8-9`: the doc comment says "one effect, then the two memos" but a useState comes first. Cosmetic.

## Resolution (integrator S3), commit f7e31281
- 1: `messageOf(opaqueErr, t('login.login_failed'))` (recipe shape `V.message || t(...)`).
- 2: window.self descriptor saved/restored in afterEach; pickup fetch asserted with `{ credentials: 'include' }`.
- 3: useSignupPlans doc comment fixed.
- Integrator additions: LoginPage.signup.test.jsx → .tsx (typed, no forbidden constructs; 15/15 on the refactor and on base LoginPage.jsx); repeated setup factored (test duplication delta 0 vs base 26228). Gates: vitest 11 files / 233 tests, full typecheck 0, ts-ratchet 2438 (base), check:fast 39/39.
