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
    // One row per item of a list inside a list (shared/expr/flatten.mjs).
    'flatten',
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
 * R2 — what an `ai_step` that is BOUND TO AN AGENT lets that agent do here.
 *
 * Exactly these three keys, exactly booleans, and the whole set is written on
 * every step the builders produce — `agentPermissions` is never left absent
 * and never left half-filled.
 *
 * ── EEN ONTBREKENDE SLEUTEL BETEKENT NIETS, NOOIT ALLES ─────────────
 * De grants-map in core/agentRuntime/toolPolicy.js leest een ONTBREKENDE
 * app-entry wel als "alles van deze app", en dat is daar juist: die agents
 * hadden die toolbelt gisteren ook, dus breed lezen geeft niemand iets nieuws
 * (de geen-migratieregel in de modulekop daar). Hier bestaat dat gisteren
 * niet. Een ai_step met een agent is een NIEUW oppervlak, dus er is geen
 * gedrag te bewaren en de uitzondering heeft geen grond: afwezig is `false`,
 * op alle drie.
 *
 * En dat geldt per sleutel, niet alleen voor het hele object. `{useTools:true}`
 * mag `useKnowledge` niet als `undefined` achterlaten, want de eerstvolgende
 * lezer die `!== false` schrijft leest dat als ja. Daarom bouwen de builders
 * het object OPNIEUW op uit deze drie namen (sanitizeAgentPermissions in
 * builderTools/stepBuilders.js) in plaats van een patch erin te mengen.
 *
 * Waarom alle drie versmallen en niet één ervan verbreden: `startAutomations`
 * start neveneffecten in naam van de automation-eigenaar, `useTools` verstuurt,
 * `useKnowledge` leest documenten. Alle drie zijn vermogen-vragen waar een
 * verkeerde gok de eigenaar iets geeft wat hij nooit heeft aangevinkt.
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
// Mirrors services/documentRenderer.js FORMATS / CONTENT_FORMATS and the
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
const DECK_VISUALS = require('../../core/documents/deckChart');
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
const DECK_LOOK = require('../../core/documents/deckThemeOptions');
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
 * ── DE TERMINALE STAPSOORTEN — EEN LIJST, ELF LEZERS ────────────────────────
 *
 * Step types after which NOTHING runs. A terminal step ends the walk: any edge
 * leaving it is dead, no downstream step can bind to its output, and no error
 * branch can start from it.
 *
 * De reden dat dit één geëxporteerde set is en geen elf losse literals: een
 * terminale soort is pas terminaal als ÉLKE lezer dat weet. Kent de ene plek
 * hem wel en de andere niet, dan is dezelfde graaf op de ene plek geldig en op
 * de andere niet — en dat merkt iemand pas als een automatisering halverwege stopt of
 * de editor een rand accepteert die de validator weigert.
 *
 * WIE LEEST DEZE LIJST (de canonieke inventaris; de drifttests bewaken hem —
 * server: automation/validate/terminalSteps.test.js, client:
 * agent-hub …/Builder/flow/terminalSteps.test.js):
 *
 *   SERVER — afdwingend
 *     1. validate/graph.js            een rand die uit een terminal vertrekt
 *                                     (`edge.after_terminal`)
 *     2. constants.js                 ON_ERROR_FORBIDDEN_SOURCE_TYPES hierboven
 *     3. builderTools/draftGraph.js   ERROR_BRANCH_FORBIDDEN_SOURCES — de
 *                                     LLM-zijde-spiegel van 2
 *     4. core/automationRunner/runDag.js  de wandeling STOPT hier. Dit is het
 *                                     mechanisme zelf: stop_error eindigde de
 *                                     run alleen doordat het GOOIT, dus een
 *                                     terminal die succesvol eindigt had tot nu
 *                                     toe helemaal geen manier om te eindigen.
 *
 *   SERVER — proza die het model leest (geen code, wel bindend)
 *     5. automation/builderPrompt.js  de typecatalogus + de on_error-verbodslijst
 *     6. builderTools/schemas.js      dezelfde verbodslijst in de
 *                                     builder_wire_error_branch-beschrijving
 *
 *   CLIENT — afdwingend, allemaal via de spiegel in
 *   agent-hub …/Builder/flow/terminalSteps.js
 *     7.  mapping/upstream.js          geen variabelengroep — niets kan eraan binden
 *     8.  flow/useStepDrop.js          drop-om-achter-te-plakken weigert
 *     9.  flow/nodeDropTarget.js       sleep-om-te-ketenen weigert `from`
 *     10. flow/useEdgeEditCallbacks.js handmatig een rand tekenen weigert
 *     11. flow/nodes/<X>Node.jsx       geen "+"-knop, sourceConnectable={false}
 *
 * NIET in deze lijst, met reden:
 *   - `layer_output` heeft wél familie `end`, maar is NIET terminaal: een
 *     flowlet keert terug naar zijn AANROEPER en die loopt door. De client-
 *     drifttest houdt die uitzondering expliciet bij (END_NOT_TERMINAL), zodat
 *     een NIEUWE end-familie niet stilzwijgend hetzelfde voorrecht erft.
 *   - Dat `return_to_app` binnen een flowlet/Step verboden is, is een APARTE
 *     regel (validate/graph.js, `layer.return_to_app_forbidden`) en geldt niet
 *     voor stop_error: een stop mag overal, want die faalt de hele run.
 */
const TERMINAL_STEP_TYPES = new Set(['stop_error', 'return_to_app']);

/**
 * `return_to_app` — wat de app na de run doet.
 *
 * Drie gesloten vocabulaires. Ze reizen als DATA in `_appEffects` naar een
 * app-runtime die ouder kan zijn dan de automatisering, dus een waarde buiten deze
 * sets is geen typefout maar een effect dat aan de andere kant stil zou
 * verdwijnen — daarom weigert de validator hem en logt de runner hem.
 */
// Wat de app opnieuw laadt. `tableViews` = de gegevens van het scherm;
// `resetForm` = het formulier dat de actie startte weer leeg.
const RETURN_TO_APP_REFRESH_MODES = new Set(['tableViews', 'resetForm']);
// Wat de app doet als de terugkeer zélf niet uitvoerbaar is (het genoemde
// scherm bestaat niet in deze app-versie, er is geen formulier om te legen).
// `stay` = blijf staan waar je bent — de versmallende default; `errorScreen` =
// stuur de bezoeker naar het foutscherm van de app.
const RETURN_TO_APP_ON_ERROR_MODES = new Set(['stay', 'errorScreen']);
// Dezelfde tonen als de toast-stap van App Studio (showToast in
// agent-hub …/AppStudio/runtime/useActionRunner.js).
const RETURN_TO_APP_TOAST_TONES = new Set(['info', 'success', 'warning', 'danger']);
// Bovengrens op de toast-template en op de record-verwijzing. Beide worden bij
// elke autosave in hun geheel opnieuw opgeslagen, net als elk ander vrij
// tekstveld hier, en beide gaan als string over de draad naar de browser.
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
 * ── WAT NIET IN EEN LOOP-BODY OF EEN PARALLELLE TAK MAG ─────────────────────
 *
 * De contract-scope-regels (layer/block) staan in validate/graph.js en kijken
 * alleen naar TOP-LEVEL stappen. Een genestelde stap loopt langs
 * `checkStep(..., { nested: true })` in stepRules.js, en dát is de enige plek
 * die deze lijst leest — dus een soort die hier ontbreekt, valideert binnen een
 * lus of een tak volkomen schoon.
 *
 * TWEE FAMILIES, ÉÉN LIJST — omdat de PLEK dezelfde is en één lijst maar op één
 * manier kan wegdrijven:
 *
 *  1. STAPPEN DIE PAUZEREN (`form_page`, `approval`). Hervatten speelt de
 *     PARENT-graaf per step-id opnieuw af, en sub-stapregels dragen een
 *     parent_step_id die de replay bewust overslaat — dus een pauze in een
 *     body/tak wordt op runtime wél binnengegaan en daarna nooit meer
 *     geadresseerd (de goedkeur-actie / de publieke form-URL hebben geen stap
 *     om te hervatten). execApproval en execFormPage gooien de twee fouten die
 *     isRunPause identiek behandelt, dus ze krijgen de identieke regel; alleen
 *     de bewoording en de code verschillen. (Eén publieke form-URL kan boven-
 *     dien maar één wachtende pagina tegelijk tonen, dus N parallelle
 *     form-pagina's zouden ook dubbelzinnig zijn als de replay er wél bij kwam.)
 *
 *  2. DE STAP DIE DE RUN BEËINDIGT (`return_to_app`). `TERMINAL_STEP_TYPES`
 *     hierboven maakt hem terminaal door runDag's wandeling te breken — maar
 *     in een sub-graaf is die wandeling niet de RUN. Concreet, en beide kanten
 *     zijn fout:
 *       · LOOP-BODY   — execFlow draait de body met `recordSteps:false` en
 *         `suppress:true`, dus er komt geen runregel; `deriveRunOutcome`
 *         (appStudio/actionExecutor/automationBridge.js) vindt nooit
 *         `_appEffects` en de app krijgt NIETS. Het `break` beëindigt alleen
 *         die iteratie: de lus draait het volgende item en de run loopt door.
 *       · PARALLELLE TAK — die regels worden wél opgenomen en erven
 *         `parentStepId: null`, dus de app krijgt "we zijn klaar, ga hierheen"
 *         terwijl de andere takken en alles ná de parallel nog draaien.
 *     `stop_error` staat hier NIET: die gooit, en een worp reist wél door elke
 *     sub-graaf omhoog. Terminaal-door-te-slagen en terminaal-door-te-gooien
 *     zijn twee verschillende mechanismen, en alleen het eerste heeft deze
 *     regel nodig.
 *
 * De palet-spiegel hiervan staat in
 * agent-hub …/Builder/flow/stepPalette.js (`NOT_INSIDE_A_LAYER`): wat de
 * validator hier weigert, hoort de editor niet aan te bieden.
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
