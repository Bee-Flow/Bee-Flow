CHANGES REQUIRED (two small fixes; the extractions themselves are behaviour-preserving)

# Review S3 / LF-A9: s3/lfa9 (de44d2a8, 57ccee0c) on b36ec171

Scope: only the two hooks plus new files are touched (10 files). useCmsBuilderStream and every other file are unchanged. The "two small helpers for the thinking parts" are `freshThinkingPart` / `withThinkingParts`, local to `hooks/appBuilderStream/events.ts:101-108`. They are not shared, and the CMS hook keeps its own copy.

## Findings

1. **New test file is JavaScript.** `agent-hub/src/components/chat/Voice/useVoiceSession.stream.test.js` (new) breaks structural-plan.md §0 ("agent-hub lint:ts-ratchet: new files must be .ts/.tsx, never .js/.jsx"). The gate only passes on slack (2439 against a budget of 2443, +1 against base). Fix: `git mv` it to `useVoiceSession.stream.test.ts` and type the fakes: `FakeMediaRecorder` fields (`state`, `mimeType`, `ondataavailable?`, `onstop?`), `bodyOf(chunks: string[])`, `frame(event: string, data: unknown)`, `turnResponse`/`lastTurnForm: FormData | null`, and `vi.mocked(authFetch)` instead of `authFetch.mockReset()`. Use no `any`, `!` or `as unknown as`. Narrow `lastTurnForm` with `if (!lastTurnForm) throw …` before `.get`.
2. **The source scan lost coverage.** `agent-hub/src/components/admin/Studio/AppStudio/AppStudio.noPurple.test.jsx:107` scans only `hooks/useAppBuilderStream.ts`. About 85 % of that hook (every event handler, the request body and the session code) now lives in `hooks/appBuilderStream/` and is no longer scanned, so the test still passes. Fix: add a root `path.resolve(__dirname, '../../../../hooks/appBuilderStream'),` after line 107. No moved file holds a banned colour today, so the test stays green.

## Checked, no finding
- **Hook order and deps.** Both hooks call the same useState/useRef/useEffect/useCallback sequence in the same order, with identical dependency arrays. `runTurn` deps are `[appId, patchAssistant, patchTurn, markFirstEvent]`; `vadTick`, `submitTurn`, `playTts` and `connect` are unchanged. No hook sits inside a condition. Every ref is passed as the ref object and read with `.current` at event or tick time; callback refs are read the same way (`ctx.cb.onDraft.current`, `ctx.onTurnCompleteRef.current`). `appId` and the setters are captured at callback creation, as the base closure did. `submitTurn` passes `playTts` through an arrow, so the later `const` is resolved at call time, as before.
- **SSE.** `HANDLERS` has exactly the 22 base cases. An unknown event (including `constructor` and the like, through the hasOwnProperty guard) is ignored, as the base default did. Each handler makes the same state updates in the same order. `sawDone`, `errored`, `continuation` and `doneInfo` move to a per-turn `outcome` object with identical semantics. The abort of the previous controller is still synchronous. The try still covers fetch, safeText, the read loop and the drop check. The continuation legs and `send`/`stop` are unchanged.
- **Voice.** Release order (recorder, tracks, audioCtx.close, abort, pause, then the ref resets), the VAD tick, the TTS lifecycle and the SSE frame parsing are identical. `isAbortError`/`messageOf` change behaviour only for null/undefined throws (no TypeError now) and for a non-string `message` (now the fallback 'Network error'). For an Error, the user-visible text is unchanged. `STATES`→`VOICE_STATES` is internal: the hook still returns `STATES`, and no agent-hub, mobile or server test reads that source. The new stream test passes against the BASE hook too (13/13), so it is a true characterisation.
- **Types.** No forbidden constructs added. The public option types are re-exported unchanged; `useBuilderTurn`/`useTurnControls` typecheck. `connect` now returns `Promise<VoiceSessionInfo>` instead of `Promise<any>`. That is tighter, not looser, and no caller breaks.
- Nits (optional): `useVoiceSession.ts:191` keeps the pre-existing `(err as Error).message`; `messageOf(err, 'Could not start voice session')` would finish the job. `useAppBuilderStream.ts:157/195-196` has one missing blank line and one doubled blank line.

## Gates
- long-function: 265 ✅
- check:fast: 39/39 ✅
- duplication-ratchet ✅
- agent-hub typecheck ✅
- eslint on changed files: 0 errors, 11 warnings (base 24)
- lint:dead ✅
- vitest related: 165 files, 2183 tests ✅
- Merge onto d9f6070a: clean auto-merge, typecheck ✅, same vitest 165/2183 ✅

## Resolution (integrator S3)
- 1: useVoiceSession.stream.test.js → .ts, typed (no forbidden constructs), shared fakes in Voice/voiceTestKit.ts (also used by useVoiceSession.test.js; test duplication back to base 26228). d1a14394. The null-history fixture entry, dropped for typing, was put back in the JS useVoiceSession.test.js with its original assertion (39e08627); passes on b36ec171's hook and on the refactor.
- 2: AppStudio.noPurple.test.jsx also scans hooks/appBuilderStream (d1a14394).
- nits: useVoiceSession.ts:191 `(err as Error).message` → `messageOf(err, 'Could not start voice session')` (same text for Error throws; null/undefined throw no longer a TypeError); blank lines fixed.
