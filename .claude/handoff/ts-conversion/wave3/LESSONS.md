# Lessons from wave 3 (input for improving the converter before the server)

Numbers: 432 files converted by tooling (`scripts/ts-convert-codefix.mjs` + runtime observations) left 3350
type errors in them plus ~200 in importers. Agents then needed ~6 rounds (fix, review, integration, final).

## What the tooling left behind (by frequency, from the agents' reports)

1. Props interfaces with every prop REQUIRED. Callers omit props all the time (EmbedChat vs InputArea: 11 missing
   props). Rule the tool can apply: a prop that at least one call site omits, or that the component reads via
   `?.`, `||`, a default value or `if (prop)`, is optional. Also: a prop a caller passes that the component does
   not declare must be ADDED as optional (agents otherwise delete it at the call site = behaviour change).
2. Nullability: `null` passed where the type says `T | undefined` (and the reverse). Hundreds of errors.
   Infer `T | null` when any caller passes null or a `useState(null)` value; never emit `?: T` alone for those.
3. `useState([])` / `useState(null)` / `useRef(null)` without a type argument -> `never[]` / `null` state.
   Infer the type argument from the setter calls in the same component.
4. Callbacks and setters typed `(x: string) => void` while the caller passes `Dispatch<SetStateAction<...>>`
   or a number setter; `unknown` handler parameters (`SseHandler payload: unknown`).
5. `unknown` / `Record<string, unknown>` where an exported domain type exists (ToolRow, ToolDraft, BrowseEvent,
   RuntimeDescriptor). Prefer an existing exported type whose fields match the runtime observation.
6. Duplicate local types for the same concept (two `UsageRow`, two `OrgGroup`, `WebpageCardData` vs `WebpageRow`,
   `ChatAttachment` with an index signature vs `ComposerAttachment` interface). The tool should reuse one.
7. Literal types too narrow (`spacing: { nodesep: 64 }` as literals; `count: number` while a caller passes '!').
8. Index signature vs interface assignability: emit `type` aliases (implicit index signature) for plain data
   shapes, `interface` only for component props.

## What agents got wrong (put in the agent prompts, or make the tool unnecessary)

- Added `?.` / early returns on values the old JS dereferenced unguarded (turns a crash into a silent path).
  Reviews restored ~40 of these. The prompt must say: narrowing assertion instead.
- Removed JSX props that the receiving component does not declare. Fix the receiver's type instead.
- Integration agents re-introduced guards that reviewers had removed. Each round must get the list of
  already-restored spots, or eqcheck must run as a gate on every round.
- Chunking by path put a mismatch's two sides in different agents. Assign ownership by directory AND let the
  integration round see the full error list; give shared types (hooks/, api/, lib/, shared components) to one owner.
- Haiku (effort low) gave up on nearly every cross-file error; Sonnet (effort low) did the work.

## Tooling gaps

- `eqcheck.mjs` needs esbuild from server/node_modules: in a fresh worktree run `npm ci` in server/ first.
- `/tmp/wave3` does not survive a reboot; keep per-chunk inputs regenerable (they are, via chunk.mjs).
- A per-round eqcheck over ALL changed files (also the non-wave-3 importers) catches behaviour changes early.

## Real bugs found (worth issues)

See STATUS.md plus: pyannote threshold stored as string (adminPanel.types), getIntegrationIcon ignores size,
LearningCenter reads courses[].lessons (org lessons never registered), fCur on pg string sums crashed (fixed),
onFocusField('name') string vs handle (datatable/knowledge editors), FieldKeyCombobox options `{value}` vs `o.key`,
useTranscription updaters with null prev, WebpagesList rename with undefined name, NavRow flyout without children,
RibbonFlightLayer reads `internals` that getNode never returns, touch drags read clientX from TouchEvent (NaN),
demo knowledge fixture filters never applied (fixed).
