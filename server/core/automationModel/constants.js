/**
 * Vocabulary and ceilings the automation validator checks against: the legal
 * step types, edge labels and colours, the per-step-type value sets
 * (form_page, parse_json, datetime, notification channels, …), the reserved
 * name lists, and the graph-size caps. Literals only — no requires, so every
 * rule module can pull from here without a cycle.
 */

/**
 * Ceiling for an approval's own deadline, in hours (30 days).
 *
 * Mirrors APPROVAL_MAX_TTL_MS in core/automationRunner/engine.js — the engine
 * clamps silently, so this rule exists to TELL the author their 90-day deadline
 * will not be honoured rather than letting them find out a month later. Keep
 * the two in step; the builder's clamp (builderTools' clampApprovalHours and
 * the editor's formState) uses this same bound.
 */
const APPROVAL_MAX_EXPIRY_HOURS = 720;
// Rich-approval caps. Attachments are decision material, not a file share;
// fields are questions a person answers before deciding, not a second form
// product. Both mirrored by the builder normalizer and the editor.
const APPROVAL_MAX_ATTACHMENTS = 5;
const APPROVAL_MAX_FIELDS = 20;

const VALID_STEP_TYPES = new Set([
    'trigger', 'integration_action', 'ai_step', 'condition', 'loop', 'code', 'notification',
    // Phase 2 flow primitives
    'approval', 'parallel',
    // n8n-style utility nodes (Phase A: data + control flow, Phase B: collection ops)
    'set', 'datetime', 'wait', 'stop_error', 'switch',
    'filter', 'limit', 'dedupe', 'aggregate', 'summarize',
    // flatten: a row per inner item (shared/expr/flatten.mjs); read_table / table: files as tables, edited without code.
    'flatten', 'read_table', 'table',
    // Scan a value for personal data with the Privacy Shield's detector and
    // branch on the answer.
    'guard',
    // Replace personal data with reversible placeholders, minted into the run
    // vault so the runner's existing restore points put the real values back.
    'tokenize',
    // Put those real values back at a point the author chooses.
    'untokenize',
    // Extract named fields from JSON data (deterministic paths or AI).
    'parse_json',
    // Layers (inline sub-flows): call a layer / return from one.
    'call_layer', 'layer_output',
    // Steps (reusable building blocks, kind='block'): call an external Step.
    'call_block',
    // Outbound HTTP/webhook call.
    'http_request',
    // A further page of the automation's public form, shown on the same /f/<token>
    // URL: mode 'input' pauses the run for the visitor's answers, mode 'ending'
    // shows the closing summary.
    'form_page',
    // Render upstream text into a real PDF or Word file, kept for a bounded
    // time so a form page can hand it back as a download.
    'generate_document',
    // Fill a DESIGNED document (an invoice, a quote, a letter on letterhead)
    // with the run's values and keep the PDF. The sibling of the step above,
    // the other way round: that one lays text out, this one fills a layout.
    'fill_document',
    // ONE slide of a presentation — a title, some markdown content, speaker
    // notes. Pure and cheap: it produces a slide OBJECT, never a file, so a
    // forEach over rows yields one slide per row for the step below.
    'slide',
    // Turn slides — an ai_step's markdown outline, a list of `slide` steps, a
    // loop's results — into a real PowerPoint (.pptx) or a PDF deck in the
    // org's house style, kept like a generate_document file.
    'presentation',
    // Pull named, typed fields out of a piece of text (an invoice, an e-mail,
    // a PDF's text) with the ONE extraction model the admin configured —
    // never the automation's chat tier. Its `fields` list IS its output shape.
    'data_extraction',
    // Read or write rows of an organisation-scoped datatable — the only step
    // whose effect outlives the run.
    'datatable',
    // Put text into a knowledge base, so an agent can answer from it later.
    // The other step whose effect outlives the run, and the one whose output
    // an agent will state as fact — which is why its knowledge base is
    // authorised at save, at activate AND at run time (K10).
    'knowledge_write',
    // End the run and hand the Studio App that started it a short instruction
    // set: which screen to open, what to say, what to refresh. The other
    // TERMINAL type (see TERMINAL_STEP_TYPES) — nothing after it ever runs.
    'return_to_app',
    // A free-form canvas annotation (BFSF-411) — sticky-note text tied to a
    // position/size, persisted like any other step so it survives save/export,
    // but never wired: it carries no edges and the execution graph never
    // dispatches it (execution.js's runStepLeaf + execFlow.js's
    // buildLinearEdges both special-case it). See NOTE_* below for its own
    // bounds — everything else about it is presentational.
    'note',
]);

/**
 * What a `knowledge_write` step does when the text it is about to store is
 * NEARLY the same as something already in the knowledge base.
 *
 *   skip     leave the existing document alone (the default: an automation that
 *            re-runs should not quietly fork an article into two versions)
 *   merge    ask the model to fold the new text into the existing one
 *   replace  overwrite the existing document
 *   add      store it anyway, as a second document
 *
 * An EXACT duplicate is handled before any of these by the content hash;
 * this is the fuzzy case (simhash), where the right answer genuinely depends
 * on what the automation is for.
 */
const KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES = Object.freeze(['skip', 'merge', 'replace', 'add']);

/**
 * R2: what an `ai_step` that is BOUND TO AN AGENT lets that agent do here.
 *
 * Exactly these three keys, exactly booleans, and the whole set is written on
 * every step the builders produce: `agentPermissions` is never left absent
 * and never left half-filled.
 *
 * ── A MISSING KEY MEANS NOTHING, NEVER EVERYTHING ───────────────────
 * The grants map in core/agentRuntime/toolPolicy.js DOES read a MISSING
 * app entry as "everything of this app", and that is right there: those agents
 * had that toolbelt yesterday too, so a broad reading gives nobody anything new
 * (the no-migration rule in the module header there). Here that yesterday does
 * not exist. An ai_step with an agent is a NEW surface, so there is no behaviour
 * to preserve, and the exception has no basis: absent is `false`, on all three.
 *
 * And that holds per key, not only for the whole object. `{useTools:true}`
 * must not leave `useKnowledge` as `undefined`, because the next reader who
 * writes `!== false` would read that as yes. That is why the builders
 * rebuild the object from these three names (sanitizeAgentPermissions in
 * builderTools/stepBuilders.js) instead of mixing a patch into it.
 *
 * Why narrow all three and not widen one of them: `startAutomations` starts
 * side effects in the name of the automation owner, `useTools` sends,
 * `useKnowledge` reads documents. All three are capability questions where a
 * wrong guess hands the owner something he never ticked.
 */
const AI_STEP_AGENT_PERMISSION_KEYS = Object.freeze(['startAutomations', 'useKnowledge', 'useTools']);

/**
 * How many skills one ai_step may attach — the FIRST is the leading one.
 *
 * Mirrors SKILL_CAP in core/tools/skillInjection.js, which is what actually
 * truncates (mergeSkillIds: attached first, deduped, cut at the cap). Restated
 * rather than imported because this module is literals-only on purpose — every
 * rule module pulls from it and skillInjection reaches the skill store. The
 * drift is covered by a test instead (automation/validate.agentStep.test.js),
 * so a cap change there fails here rather than silently dropping the sixth
 * skill an author picked.
 */
const MAX_AI_STEP_SKILL_IDS = 5;

// The step types that call a model. `summarize` is NOT one of them: it is an
// aggregate op over a collection, and the client fallback in ComplianceBlock
// must agree (CONTRACTS.md). core/privacy/dataFlow.js reads this too.
const AI_STEP_TYPES = Object.freeze(['ai_step', 'data_extraction', 'ai_tool']);

// A note's own field ceilings (BFSF-411). Generous — this is a sticky note,
// not a form — but bounded for the same reason every other free-text/size
// field here is: an unbounded value re-saves in full on every autosave.
const NOTE_MAX_TEXT_LENGTH = 4000;
const NOTE_MIN_SIZE = 40;
const NOTE_MAX_SIZE = 2000;
// Cosmetic swatch keys — same vocabulary as EDGE_COLOR_KEYS (the canvas's one
// colour palette, agent-hub .../Builder/flow/edgeColors.js) so a note's colour
// picker never needs a second list to agree with.
const NOTE_COLOR_KEYS = new Set(['blue', 'green', 'amber', 'orange', 'rose', 'red', 'cyan', 'slate']);

/**
 * What a `datatable` step may do. A closed vocabulary, because every operation
 * maps to one compiler entry point and there is deliberately no "run this SQL".
 *
 *   find_rows     look rows up; changes nothing
 *   count_rows    how many rows match; reads no row data at all
 *   add_row       always inserts, even if a matching row exists
 *   save_row      updates the row matching `matchColumn`, or inserts it
 *   update_rows   changes every row matching `where` (>= 1 condition required)
 *   delete_rows   removes every row matching `where` (>= 1 condition required)
 *
 * find_rows is the default a dropped node starts on: it is the only one that
 * cannot change anything, the same reasoning privacyModel.js uses to seed
 * 'check' rather than a destructive default.
 *
 * count_rows exists because find_rows's count is `rows.length` CLAMPED BY THE
 * PAGE SIZE, so a condition branching on `count > 100` against a default page
 * of 50 is unreachable — it answers a question nobody could otherwise ask
 * without paging the whole table through the run.
 */
const DATATABLE_OPS = new Set(['find_rows', 'count_rows', 'add_row', 'save_row', 'update_rows', 'delete_rows']);
// Operations that write. Kept as a derived-by-hand list rather than
// `op !== 'find_rows'` so a new read-only op cannot silently become a write.
const DATATABLE_WRITE_OPS = new Set(['add_row', 'save_row', 'update_rows', 'delete_rows']);
// Operations that refuse to run without at least one condition. An unbounded
// update or delete is never what an author meant, and stepDataSource.js:46-55
// records the incident where a dropped filter listed an app's every attachment.
const DATATABLE_FILTERED_OPS = new Set(['update_rows', 'delete_rows']);
const DATATABLE_MAX_FILTERS = 20;
// The id the builder gives a table it has only PROPOSED (not created yet): a
// step staged in a preview points at "pending:1" until the user presses Apply
// and the server swaps it for the real id. One definition, shared by the
// validator, the builder's pendingDatatables helpers and the runner, so a
// pending id can never be told apart differently in two places. The client
// twin is agent-hub/src/components/automation/Builder/chat/pendingTables.ts.
const PENDING_DATATABLE_RE = /^pending:[1-9]\d{0,2}$/;
const DATATABLE_MAX_LIMIT = 1000;
// How the conditions join each other. ONE top-level combinator: 'status is new
// OR retry' is the shape authors ask for, and it compiles to a single OR group
// with the access predicate ANDed OUTSIDE it. Nested groups are deliberately
// not expressible — the step's whole safety story is that it is a closed
// descriptor rather than a query language.
const DATATABLE_MATCH_MODES = new Set(['all', 'any']);

const HTTP_REQUEST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
// The methods that CHANGE something. Mirrors execOutbound.js's
// HTTP_REQUEST_WRITE_METHODS — this step's own isSideEffect, and already what
// the dry-run gate refuses to dispatch. Listed by hand rather than derived as
// "not GET/HEAD" for the same reason DATATABLE_WRITE_OPS is: a method added to
// HTTP_REQUEST_METHODS later must not silently become cacheable.
const HTTP_REQUEST_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// The VISIBLE cache tier's window (step.cacheInto.maxAgeDays). Mirrors
// core/automationRunner/httpCache.js and the ten-year ceiling
// routes/datatables.js puts on a retention window — a fat-fingered 36500 must
// be a refusal, not "never".
const CACHE_INTO_MAX_DAYS = 3650;
// Mirrors core/documents/render/documentRenderer.js FORMATS / CONTENT_FORMATS and the
// TTL clamp in engine.js's execGenerateDocument. Kept as literals here for the
// same reason BRANCHER_TYPES is: validate.js must not pull in the runner.
const GENERATE_DOCUMENT_FORMATS = new Set(['pdf', 'docx']);
const GENERATE_DOCUMENT_CONTENT_FORMATS = new Set(['markdown', 'html']);
const GENERATE_DOCUMENT_MIN_TTL_DAYS = 1;
const GENERATE_DOCUMENT_MAX_TTL_DAYS = 90;
// fill_document shares that TTL window (one idea of "a file a run may keep").
// Its own cap is on the number of placeholders a document may be filled with —
// the same literal execFillDocument clamps to, kept here for the same reason.
const FILL_DOCUMENT_MAX_VALUES = 200;
// presentation / slide — mirrors core/documents/deckModel.js SLIDE_LAYOUTS and
// services/presentationRenderer.js's formats; literals here so validate.js
// stays free of the renderer. 'auto' is the slide step's "pick from content".
const PRESENTATION_FORMATS = new Set(['pptx', 'pdf']);
const SLIDE_LAYOUTS = new Set(['auto', 'title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing']);
// The slide VISUALS vocabulary (chart types, the emphasis styles) is owned by
// core/documents/deckChart.js — imported for the same reason as the look.
const DECK_VISUALS = require('../documents/deckChart');
const SLIDE_CHART_TYPES = new Set(DECK_VISUALS.CHART_TYPES);
const SLIDE_STYLES = new Set(DECK_VISUALS.SLIDE_STYLES);
const SLIDE_MAX_STATS = DECK_VISUALS.STATS_LIMITS.maxTiles;
// The most slides one `slides` ARRAY may name (the deck itself is capped by
// the deck model at 60 after overflow splitting — this is the earlier, cheaper
// refusal for an author who wired a whole table into it).
const PRESENTATION_MAX_SLIDES = 200;
// The deck LOOK vocabulary (preset / cover / table / font) is owned by
// core/documents/deckThemeOptions.js — imported, not restated, so a preset
// added there is valid here the same day.
const DECK_LOOK = require('../documents/deckThemeOptions');
const PRESENTATION_PRESETS = new Set(DECK_LOOK.DECK_PRESET_IDS);
const PRESENTATION_COVER_STYLES = new Set(Object.keys(DECK_LOOK.COVER_STYLES));
const PRESENTATION_TABLE_STYLES = new Set(Object.keys(DECK_LOOK.TABLE_STYLES));
const PRESENTATION_FONTS = new Set(DECK_LOOK.DECK_FONTS);
const PRESENTATION_LOGO_PLACEMENTS = new Set(Object.keys(DECK_LOOK.LOGO_PLACEMENTS));

// data_extraction — the field rules the validator, the builder tool and the
// executor (core/automationRunner/execDataExtraction.js) all read from HERE,
// so a name the builder accepts is a name the runner writes and the validator
// passes. Field names become output keys and later bindings, hence the
// lowercase-snake pattern (a `steps.<id>.output.<name>` path must stay a plain
// identifier). `date` means an ISO `YYYY-MM-DD` string.
const DATA_EXTRACTION_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'date']);
const DATA_EXTRACTION_FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const DATA_EXTRACTION_MAX_FIELDS = 30;
const DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS = 2000;
// How much of the source text reaches the model. Beyond this the executor
// keeps the head and the tail and says so in the prompt — the middle of a long
// document is where the boilerplate lives; the fields sit at either end.
const DATA_EXTRACTION_MAX_SOURCE_CHARS = 60000;

// §WS4 — edge-label rules. The runner routes labelled edges (nextEdgesFor):
// unlabelled/'on_success' fire on success, 'then'/'else' on conditions,
// 'case:<name>' on switches, 'on_error' when the step exhausts its retries
// and fails. Anything else never fires — warn so a typo ("onerror",
// "success") doesn't silently dead-end a branch.
const KNOWN_EDGE_LABELS = new Set(['then', 'else', 'on_success', 'on_error']);
// Legal values for the cosmetic edge `color` key — the canvas's swatch
// palette (agent-hub .../Builder/flow/edgeColors.js draws from
// constants/palette.js STATUS_COLORS; no shared module crosses the
// server/agent-hub boundary, and this list is stable by design).
const EDGE_COLOR_KEYS = new Set(['blue', 'green', 'amber', 'orange', 'rose', 'red', 'cyan', 'slate']);
// Step types that can meaningfully FAIL at run time — the only legal
// sources for an 'on_error' edge.
const ON_ERROR_SOURCE_TYPES = new Set([
    'integration_action', 'ai_step', 'code', 'call_layer', 'call_block', 'loop', 'parallel', 'notification', 'wait', 'http_request',
    // parse_json fails on invalid-JSON sources / AI-extraction errors.
    'parse_json',
    // tokenize fails LOUDLY rather than pass the original through unhidden —
    // no policy to read, or a detector that could not scan. An error branch is
    // the author's way to handle that without losing the run.
    'tokenize', 'untokenize',
    // generate_document fails on empty/oversized content and on unavailable
    // file storage — all things an author may want to route around rather than
    // lose the whole run over.
    'generate_document',
    // fill_document fails on a document that is gone (or somebody else's) and
    // on unavailable file storage — both worth routing around rather than
    // losing the run over.
    'fill_document',
    // presentation fails on an empty or oversized deck and on unavailable file
    // storage — same reasons as generate_document.
    'presentation',
    // data_extraction fails on an empty source, a model reply that is not the
    // requested object, and a required field the text does not contain — a
    // automation reading a folder of invoices wants the odd unreadable one routed
    // aside, not the whole run lost.
    'data_extraction',
    // datatable fails on a missing table, a revoked grant, a quota, a unique
    // violation and an unresolvable filter — all of which an author may want to
    // route around rather than lose the run over.
    'datatable',
]);
// Sources where an error branch is structurally wrong: the trigger never
// dispatches, condition/switch route by their own branch labels (an
// 'on_error' edge there would shadow the branch routing), approval and
// form_page PAUSE rather than fail, and stop_error's entire JOB is to fail
// the run.
// guard is in here for the same reason as condition/switch: it routes by its
// own branch labels, and an 'on_error' edge would shadow that routing.
// return_to_app is here for the same reason as stop_error: it is TERMINAL.
// An error branch out of a step that ends the run is a promise the runner can
// never keep — see TERMINAL_STEP_TYPES below for the full list of places that
// have to agree about that.
const ON_ERROR_FORBIDDEN_SOURCE_TYPES = new Set(['trigger', 'condition', 'switch', 'approval', 'form_page', 'stop_error', 'guard', 'return_to_app']);

/**
 * ── THE TERMINAL STEP TYPES: ONE LIST, ELEVEN READERS ───────────────────────
 *
 * Step types after which NOTHING runs. A terminal step ends the walk: any edge
 * leaving it is dead, no downstream step can bind to its output, and no error
 * branch can start from it.
 *
 * Why this is one exported set and not eleven loose literals: a terminal type is
 * only terminal once EVERY reader knows it. If one place knows it and another does
 * not, the same graph is valid in one place and invalid in the other, and someone
 * finds out only when an automation stops halfway or the editor accepts an edge
 * the validator refuses.
 *
 * WHO READS THIS LIST (the canonical inventory; the drift tests guard it:
 * server: automation/validate/terminalSteps.test.js, client:
 * agent-hub …/Builder/flow/terminalSteps.test.js):
 *
 *   SERVER, enforcing
 *     1. validate/graph.js            an edge leaving a terminal
 *                                     (`edge.after_terminal`)
 *     2. constants.js                 ON_ERROR_FORBIDDEN_SOURCE_TYPES above
 *     3. builderTools/draftGraph.js   ERROR_BRANCH_FORBIDDEN_SOURCES: the
 *                                     LLM-side mirror of 2
 *     4. core/automationRunner/runDag.js  the walk STOPS here. This is the
 *                                     mechanism itself: stop_error ended the
 *                                     run only by THROWING, so a terminal that
 *                                     ends successfully had until now no way to end.
 *
 *   SERVER, prose that the model reads (not code, but binding)
 *     5. automation/builderPrompt.js  the type catalogue + the on_error prohibition list
 *     6. builderTools/schemas.js      the same prohibition list in the
 *                                     builder_wire_error_branch description
 *
 *   CLIENT, enforcing, all via the mirror in
 *   agent-hub …/Builder/flow/terminalSteps.js
 *     7.  mapping/upstream.js          no variable group: nothing can bind to it
 *     8.  flow/useStepDrop.js          drop-to-insert-after refuses
 *     9.  flow/nodeDropTarget.js       drag-to-chain refuses `from`
 *     10. flow/useEdgeEditCallbacks.js drawing an edge by hand refuses
 *     11. flow/nodes/<X>Node.jsx       no "+" button, sourceConnectable={false}
 *
 * NOT in this list, with reason:
 *   - `layer_output` has family `end`, but is NOT terminal: a flowlet returns to its
 *     CALLER and that caller continues. The client drift test records that exception
 *     explicitly (END_NOT_TERMINAL), so that a NEW end family does not
 *     silently inherit the same privilege.
 *   - That `return_to_app` is forbidden inside a flowlet/Step is a SEPARATE
 *     rule (validate/graph.js, `layer.return_to_app_forbidden`) and does not
 *     apply to stop_error: a stop may go anywhere, because it fails the whole run.
 */
const TERMINAL_STEP_TYPES = new Set(['stop_error', 'return_to_app']);

/**
 * `return_to_app`: what the app does after the run.
 *
 * Three closed vocabularies. They travel as DATA in `_appEffects` to an app runtime
 * that may be older than the automation, so a value outside these sets is not a
 * typo but an effect that would silently vanish on the other side. That is why the
 * validator refuses it and the runner logs it.
 */
// Wat de app opnieuw laadt. `tableViews` = de gegevens van het scherm;
// `resetForm` = het formulier dat de actie startte weer leeg.
const RETURN_TO_APP_REFRESH_MODES = new Set(['tableViews', 'resetForm']);
// What the app does when the return itself is not executable (the named
// screen does not exist in this app version, there is no form to empty).
// `stay` = stay where you are, the narrowing default; `errorScreen` =
// send the visitor to the app's error screen.
const RETURN_TO_APP_ON_ERROR_MODES = new Set(['stay', 'errorScreen']);
// Dezelfde tonen als de toast-stap van App Studio (showToast in
// agent-hub …/AppStudio/runtime/useActionRunner.js).
const RETURN_TO_APP_TOAST_TONES = new Set(['info', 'success', 'warning', 'danger']);
// Upper bound on the toast template and on the record reference. Both are saved in
// full on every autosave, like every other free-text field here, and both travel
// as strings over the wire to the browser.
const RETURN_TO_APP_MAX_TOAST_CHARS = 300;
const RETURN_TO_APP_MAX_RECORD_REF_CHARS = 500;

// Step types the runtime routes by BRANCH LABEL instead of falling through on
// success. Mirrors core/automationRunner/engine.js's BRANCHER_TYPES — runDag
// routes all three identically, so an UNLABELLED edge out of any of them never
// fires. guard was missing here while condition/switch were covered, which is
// how an unlabelled guard edge stayed savable and simply never fired.
// Deliberately a copy rather than a require: engine.js pulls in the whole
// runner (stores, providers, connectors) and the validator has to stay
// loadable standalone — keep the two lists in sync by hand.
const BRANCHER_TYPES = new Set(['condition', 'guard', 'switch']);

// Keys the runner puts into `loop` beside the item on every pass
// (core/automationRunner/execFlow.js: `loop: { [itemVar]: item, _index: i }`,
// for loop bodies and forEach fan-outs alike; partialRuns.js mirrors it).
// They are bound wherever the itemVar is, so they can never mismatch a
// forEach — without this, `{{loop._index}}` in a fan-out was refused at add
// time with the advice to rename itemVar to "_index" (which would unbind the
// item), and flagged ref.loop_unbound on existing automations.
const LOOP_RUNTIME_KEYS = new Set(['_index']);

/**
 * ── WHAT MAY NOT BE IN A LOOP BODY OR A PARALLEL BRANCH ─────────────────────
 *
 * The contract-scope rules (layer/block) are in validate/graph.js and look only
 * at TOP-LEVEL steps. A nested step passes through `checkStep(..., { nested: true })`
 * in stepRules.js, and that is the only place that reads this list, so a type
 * missing here validates cleanly inside a loop or a branch.
 *
 * TWO FAMILIES, ONE LIST: because the PLACE is the same, one list can drift in one way only:
 *
 *  1. STEPS THAT PAUSE (`form_page`, `approval`). Resuming replays the PARENT
 *     graph per step id, and sub-step rules carry a parent_step_id that the replay
 *     deliberately skips, so a pause in a body/branch IS entered at runtime but then
 *     never addressed again (the approve action / the public form URL have no step
 *     to resume). execApproval and execFormPage throw the two errors that isRunPause
 *     treats identically, so they get the identical rule; only the wording and the
 *     code differ. (One public form URL can also show only one waiting page at a
 *     time, so N parallel form pages would be ambiguous too if the replay did pick them up.)
 *
 *  2. THE STEP THAT ENDS THE RUN (`return_to_app`). `TERMINAL_STEP_TYPES` above
 *     makes it terminal by breaking runDag's walk, but inside a sub-graph that walk
 *     is not the RUN. Concretely, and both sides are wrong:
 *       · LOOP BODY   execFlow runs the body with `recordSteps:false` and
 *         `suppress:true`, so no run line is written; `deriveRunOutcome`
 *         (appStudio/actionExecutor/automationBridge.js) never finds
 *         `_appEffects`, and the app gets NOTHING. The `break` ends only that
 *         iteration: the loop runs the next item and the run carries on.
 *       · PARALLEL BRANCH the lines ARE recorded and inherit
 *         `parentStepId: null`, so the app receives "we are done, go here"
 *         while the other branches and everything after the parallel still run.
 *     `stop_error` is NOT listed here: it throws, and a throw does travel up through
 *     every sub-graph. Terminal-by-succeeding and terminal-by-throwing are two
 *     different mechanisms, and only the first needs this rule.
 *
 * The palette mirror of this is in
 * agent-hub …/Builder/flow/stepPalette.js (`NOT_INSIDE_A_LAYER`): what the
 * validator refuses here should not be offered by the editor.
 */
const NESTED_FORBIDDEN_RULES = new Map([
    ['form_page', {
        code: 'form_page.nested_forbidden',
        message: (id) => `Step ${id}: form steps cannot run inside a loop or a parallel branch.`,
        hint: 'Move the form step to the main flow, before or after the loop.',
    }],
    ['approval', {
        code: 'approval.nested_forbidden',
        message: (id) => `Step ${id}: approval steps cannot run inside a loop or a parallel branch — the run pauses there and can never be approved.`,
        hint: 'Move the approval to the main flow, before or after the loop: approve once, then let every item through.',
    }],
    ['return_to_app', {
        code: 'return_to_app.nested_forbidden',
        message: (id) => `Step ${id}: "Back to the app" steps cannot run inside a loop or a parallel branch — they end the whole run, and a loop or a branch is not the end of it.`,
        hint: 'Move the step to the main flow, after the loop or the parallel step: it is the last thing the automation does.',
    }],
]);

// A segment every reader takes as a plain name: an ASCII identifier, the
// expression engine's name. The path grammar (shared/expr/path.mjs) reads
// more in a reference or a {{ }} placeholder (`first-name`, `prénom`), but an
// EXPRESSION does not: there a hyphen turns `steps.my-step.output.n` into a
// SUBTRACTION that silently evaluates to NaN, and a space/dot breaks the path
// apart everywhere. Step ids and generated output field names should match it
// to be referenceable as `steps.<id>.output.<name>` in every slot; anything
// else needs the bracket form (`steps["my-step"]`), which the picker writes.
const BINDABLE_SEGMENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Channels a NOTIFICATION STEP may deliver on, per engine.js's execNotification:
// 'notification' (canonical) and 'inapp' (alias) ring the in-app bell, 'email'
// sends through sendRunEmail. NOT the same vocabulary as
// notificationDefaults.NOTIFICATION_CHANNELS (bell/email/talk), which governs the automation-level
// `notificationSettings` policy and has no 'notification' alias, so using it
// here would reject every step the builder has ever written.
const NOTIFICATION_STEP_CHANNELS = new Set(['notification', 'inapp', 'email']);

// form_page modes. 'input' waits for the visitor; 'ending' is the closing
// page (a summary of what ran) and does not pause.
const FORM_PAGE_MODES = new Set(['input', 'ending']);
const FORM_PAGE_MIN_WAIT_S = 60;
const FORM_PAGE_MAX_WAIT_S = 7 * 24 * 3600;

// parse_json field contract. Names are identifier-safe (they become output
// keys bound as steps.<id>.output.<name>). Paths are RELATIVE to the parsed
// source and checked with the runner's own relative reader
// (refPaths.relativePathTokens, mirroring shared getRelativePath) — a regex
// here was a second grammar that took `$.order.id` for valid and then
// resolved it to nothing.
// Lookahead bans prototype-plumbing names (__proto__/constructor/prototype) —
// assigning them at runtime would not create an own key, so the field would
// silently vanish from the step output while validation stayed green.
const PARSE_JSON_FIELD_NAME_RE = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PARSE_JSON_FIELDS = 50;

const DATETIME_OPS = new Set(['now', 'parse', 'format', 'addDays', 'addHours', 'addMinutes', 'diff', 'extract']);
const SUMMARIZE_OPS = new Set(['sum', 'count', 'avg', 'min', 'max']);
const LIMIT_MODES = new Set(['first', 'last']);
const DATETIME_PARTS = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'dayOfWeek']);
const DATETIME_DIFF_UNITS = new Set(['days', 'hours', 'minutes', 'seconds']);

// Inline-layer keys: lowercase snake, must start with a letter. Shared
// contract with the builder tools and the frontend layer helpers.
const LAYER_KEY_RE = /^[a-z][a-z0-9_]*$/;

// Prototype-plumbing names as OWN field names silently break at run time:
// assigning `__proto__` doesn't create an own key, so the field vanishes from
// the step output while validation stayed green (C17). Same rationale as
// PARSE_JSON_FIELD_NAME_RE's lookahead; banned for set/layer_output too.
const RESERVED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// §WS1.4 — hard ceilings on graph size, independent of the 20MB body limit.
// Without these, a single authenticated save can submit a pathological
// definition (hundreds of thousands of trivial nodes) that bloats the JSONB
// column/version history and burns CPU on the O(steps+edges) topo-sort + the
// per-step Levenshtein suggestion work on every validate/activate/run. The
// caps are far above any real automation, so they only ever trip on abuse.
const MAX_STEPS = 500;          // per graph (root or a single layer)
const MAX_EDGES = 2000;         // per graph
const MAX_TOTAL_NODES = 3000;   // root + all layers combined

/**
 * Trigger kinds an automation may declare as ADDITIONAL entry points
 * (`definition.triggers[]`). webhook and app_event have carried their own
 * per-trigger storage rows since 2026-07; schedule joined in 2026-09 with the
 * `automation_schedules` table. manual / form / agent_call / app_trigger stay
 * primary-only: they are ways of firing the one entry point an automation exposes
 * to a person, a visitor, an agent or a Studio app.
 */
const SECONDARY_TRIGGER_KINDS = new Set(['webhook', 'app_event', 'schedule']);

module.exports = {
    SECONDARY_TRIGGER_KINDS,
    DATATABLE_OPS,
    DATATABLE_WRITE_OPS,
    DATATABLE_FILTERED_OPS,
    DATATABLE_MAX_FILTERS,
    PENDING_DATATABLE_RE,
    DATATABLE_MAX_LIMIT,
    DATATABLE_MATCH_MODES,
    APPROVAL_MAX_EXPIRY_HOURS,
    APPROVAL_MAX_ATTACHMENTS,
    APPROVAL_MAX_FIELDS,
    VALID_STEP_TYPES,
    KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES,
    AI_STEP_AGENT_PERMISSION_KEYS,
    MAX_AI_STEP_SKILL_IDS,
    AI_STEP_TYPES,
    HTTP_REQUEST_METHODS,
    HTTP_REQUEST_WRITE_METHODS,
    CACHE_INTO_MAX_DAYS,
    GENERATE_DOCUMENT_FORMATS,
    GENERATE_DOCUMENT_CONTENT_FORMATS,
    FILL_DOCUMENT_MAX_VALUES,
    GENERATE_DOCUMENT_MIN_TTL_DAYS,
    GENERATE_DOCUMENT_MAX_TTL_DAYS,
    PRESENTATION_FORMATS,
    SLIDE_LAYOUTS,
    PRESENTATION_MAX_SLIDES,
    PRESENTATION_PRESETS,
    PRESENTATION_COVER_STYLES,
    PRESENTATION_TABLE_STYLES,
    PRESENTATION_FONTS,
    PRESENTATION_LOGO_PLACEMENTS,
    SLIDE_CHART_TYPES,
    SLIDE_STYLES,
    SLIDE_MAX_STATS,
    DATA_EXTRACTION_FIELD_TYPES,
    DATA_EXTRACTION_FIELD_NAME_RE,
    DATA_EXTRACTION_MAX_FIELDS,
    DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS,
    DATA_EXTRACTION_MAX_SOURCE_CHARS,
    KNOWN_EDGE_LABELS,
    EDGE_COLOR_KEYS,
    ON_ERROR_SOURCE_TYPES,
    ON_ERROR_FORBIDDEN_SOURCE_TYPES,
    TERMINAL_STEP_TYPES,
    RETURN_TO_APP_REFRESH_MODES,
    RETURN_TO_APP_ON_ERROR_MODES,
    RETURN_TO_APP_TOAST_TONES,
    RETURN_TO_APP_MAX_TOAST_CHARS,
    RETURN_TO_APP_MAX_RECORD_REF_CHARS,
    BRANCHER_TYPES,
    LOOP_RUNTIME_KEYS,
    NESTED_FORBIDDEN_RULES,
    BINDABLE_SEGMENT_RE,
    NOTIFICATION_STEP_CHANNELS,
    FORM_PAGE_MODES,
    FORM_PAGE_MIN_WAIT_S,
    FORM_PAGE_MAX_WAIT_S,
    PARSE_JSON_FIELD_NAME_RE,
    MAX_PARSE_JSON_FIELDS,
    DATETIME_OPS,
    SUMMARIZE_OPS,
    LIMIT_MODES,
    DATETIME_PARTS,
    DATETIME_DIFF_UNITS,
    LAYER_KEY_RE,
    RESERVED_PROTO_KEYS,
    NOTE_MAX_TEXT_LENGTH,
    NOTE_MIN_SIZE,
    NOTE_MAX_SIZE,
    NOTE_COLOR_KEYS,
    MAX_STEPS,
    MAX_EDGES,
    MAX_TOTAL_NODES,
};
