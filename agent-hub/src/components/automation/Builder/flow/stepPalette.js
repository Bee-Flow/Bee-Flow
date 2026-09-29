import {
    Sparkles, Repeat, Code, Bell, Webhook, Clock, MousePointer2, Zap, Bot, AppWindow,
    Pencil, Hourglass, OctagonX, Split, ChevronsDown, Copy, Layers, Sigma, LogOut, Box, Globe,
    ClipboardList, CheckCircle2, ShieldAlert, ShieldCheck, FileText, FileSignature, Table2, StickyNote, BookOpen, ScanText,
    RectangleHorizontal, Presentation } from 'lucide-react';
import { STEP_ICON_MAP } from './stepIcons';
import { nodeLabel, nodeDesc, nodeDefaultLabel } from './nodeDefs';
import {
    SET_STEP_NAME, SET_STEP_KEYWORDS,
    ROUTE_STEP_NAME, ROUTE_STEP_KEYWORDS,
} from './stepDisplayName';
import { defaultTriggerLabel } from './triggerLabels';
import { resolveIntegrationFromTool } from '../../../../utils/integrationIcons';
import { INTEGRATION_CATALOG, CATEGORY_ORDER as INTEGRATION_CATEGORY_ORDER } from '../../../../config/integrationCatalog';
import { shortAppLabel, actionLabelMap, uiDescription } from './appLabels';
import { OTHER_CATEGORY } from './appsRibbonLayout';

/**
 * Shared step-catalog data + search/grouping for the routines builder's
 * "Add step" surfaces. Presentation-free (icons are lucide COMPONENT refs,
 * never rendered here) so it can feed both the top ribbon (AddStepRibbon)
 * and the edge-drop popover (AddStepMenu). Payload shapes are unchanged from
 * the old NodePalette, so `handleAddNode` / `buildStepFromPayload` keep working.
 */

// ─── Trigger types (empty-canvas state) ─────────────────────────────────
// The `label` on each PAYLOAD is the node's name and comes from
// ./triggerLabels — the same map the kind switcher renames with, so a
// dropped trigger and a switched one can never disagree (BFSF-339). The
// `label` on the ITEM is the palette wording, which is a different thing
// ("On a schedule" invites you to pick; "Schedule" names the node).
const trigger = (triggerKind, extra = null) => ({ kind: 'trigger', triggerKind, label: defaultTriggerLabel(triggerKind), ...extra });

export const TRIGGERS = [
    { id: 'manual', icon: MousePointer2, label: 'Trigger manually', desc: 'Run from a button click',
      keywords: 'manual click run button start', payload: trigger('manual') },
    // Second on purpose: "someone fills in a form" is the most common
    // non-manual way a routine starts, and one drag gives a working form.
    { id: 'form', icon: ClipboardList, label: 'On form submission', desc: 'Publish a form; every submission runs this',
      keywords: 'form submission survey intake contact request public page fields upload trigger start',
      payload: trigger('form') },
    // "cron" stays in the keywords so anyone who knows the word still lands
    // here, but it is never shown — most authors have never heard of it.
    { id: 'schedule', icon: Clock, label: 'On a schedule', desc: 'Run at a fixed time, over and over',
      keywords: 'schedule cron time recurring daily hourly weekly timer trigger start', payload: trigger('schedule') },
    { id: 'webhook', icon: Webhook, label: 'On webhook call', desc: 'Run when an HTTP request arrives',
      keywords: 'webhook http post request inbound trigger start', payload: trigger('webhook') },
    { id: 'app_event', icon: Zap, label: 'On app event', desc: 'Run when something happens in a connected app',
      keywords: 'app event push email calendar drive files tickets support trigger start', payload: trigger('app_event') },
    { id: 'agent_call', icon: Bot, label: 'When an agent calls it', desc: 'Expose as a tool an AI agent can call from chat',
      keywords: 'agent chat tool function call assistant direct trigger start', payload: trigger('agent_call') },
    { id: 'app_trigger', icon: AppWindow, label: 'From a Studio App', desc: 'Run when a Studio App action calls it, with typed inputs',
      keywords: 'studio app trigger form inputs file upload action start', payload: trigger('app_trigger') },
];

// ─── Additional triggers (scoped multi-trigger slice) ───────────────────
// Once an automation already has its one primary trigger, it can still gain
// MORE entry points — webhook, app_event and (since automation_schedules,
// 2026-09) schedule. manual / form / agent_call / app_trigger only make sense
// as the single primary trigger; see automation/validate.js's `triggers[]`
// rules (SECONDARY_TRIGGER_KINDS), which reject them there. Each payload
// carries `asSecondaryTrigger: true` so DiagramPane.jsx's buildStepFromPayload
// appends to `definition.triggers[]` instead of replacing `definition.trigger`.
export const CAN_BE_SECONDARY = new Set(['webhook', 'app_event', 'schedule']);

export const SECONDARY_TRIGGERS = TRIGGERS
    .filter(t => CAN_BE_SECONDARY.has(t.payload.triggerKind))
    .map(t => ({ ...t, payload: { ...t.payload, asSecondaryTrigger: true } }));

/**
 * The trigger list as offered ALONGSIDE the steps, once a routine already has
 * its trigger. Searching "trigger" / "click" / "schedule" in the step picker
 * used to return nothing at all — triggers lived behind a mode flag that no
 * real routine ever hits, and a two-entry ribbon menu was the only way in
 * (BFSF-325).
 *
 * The two the validator accepts in `definition.triggers[]` ADD an entry point;
 * the rest can only be the one primary trigger, so they replace it — and say
 * so, because a search result should never quietly throw away someone's
 * trigger. BuildTab.addStepAt asks before it does.
 */
export function additionalTriggerItems() {
    return TRIGGERS.map(t => (CAN_BE_SECONDARY.has(t.payload.triggerKind)
        ? { ...t, desc: 'Adds another way to start this routine', payload: { ...t.payload, asSecondaryTrigger: true } }
        : { ...t, desc: 'Replaces the current trigger' }));
}

// ─── Step types ─────────────────────────────────────────────────────────
//
// A step's NAME and DESCRIPTION come from flow/nodeDefs.js, which holds the
// same facts for every node type and is kept exhaustive by a test. The palette
// owns only what is genuinely a palette concern: the id, the icon, the search
// keywords and the drop payload.
//
// KEYWORDS ARE NOT DECORATION. The ranker matches on them, so every word a node
// used to be called has to stay: someone who learned "aggregate" or "HTTP
// request" elsewhere — or here, last month — must still find the node under its
// plainer name. A rename that dropped them would make a node unfindable by the
// only word half its users know.
const stepItem = (kind, id, icon, keywords, payloadExtra = null) => ({
    id, icon, keywords,
    label: nodeLabel(kind), desc: nodeDesc(kind),
    payload: { kind, label: nodeDefaultLabel(kind), ...payloadExtra },
});

/**
 * Swap an item's English label/description for the viewer's language.
 *
 * The catalog is built at module load, where no translator exists, so this runs
 * per call instead — same shape as `gated()` below, including returning the SAME
 * OBJECT when there is nothing to change, so nothing re-renders for free.
 *
 * Deliberately conservative: it only translates an item whose label is still the
 * canonical one for its type. Two palette entries share `kind: 'form_page'` with
 * their own wording ("Form: ask for more info" / "Form: closing page"), and
 * flowlets and Steps are named by the user — none of those may be replaced by
 * their type's name. Their strings are outside this round's scope and stay
 * English rather than becoming wrong.
 */
function localised(it, t) {
    if (!t) return it;
    const kind = it.payload?.kind;
    const canonicalLabel = kind ? nodeLabel(kind) : '';
    if (!canonicalLabel || it.label !== canonicalLabel) return it;
    return { ...it, label: nodeLabel(kind, t), desc: nodeDesc(kind, t) || it.desc };
}

export const AI_STEP = {
    ...stepItem('ai_step', 'ai_step', Sparkles, 'ai prompt llm claude reason'),
};

// The AI family's second member. Its keywords carry every word someone reaching
// for "read the invoice" might type — none of which is "extraction".
export const DATA_EXTRACTION = {
    ...stepItem('data_extraction', 'data_extraction', ScanText,
        'extract extraction data fields structured parse read pull invoice receipt email e-mail pdf document text ocr '
        + 'amount date total name number scan capture json schema'),
};

/** The AI group as the palette offers it: the AI step first, then extraction. */
export const AI_ITEMS = [AI_STEP, DATA_EXTRACTION];

// ONE data-shaping node. "Edit data" (runtime type `set`) covers single
// records AND whole tables (per-row fields + table operations), and absorbed
// the retired Parse JSON node's extraction ability (the parseJson() expr +
// "Pick fields from it"). Its keywords carry Parse JSON's search terms so
// typing "parse json" still lands here — same move as ROUTE_ITEM below.
export const EDIT_DATA_ITEM = {
    ...stepItem('set', 'set', Pencil, SET_STEP_KEYWORDS),
};

export const DATA_ITEMS = [
    // First in the group and deliberately keyword-rich. The words people
    // actually search for when they want persistence — store, save, remember,
    // database, spreadsheet — appeared NOWHERE in this file before, so the
    // palette answered "we cannot do that" with silence. "Datatable" also
    // outranks "Edit data" for the query "table", which previously won it on a
    // keyword despite being in-memory only.
    stepItem('datatable', 'datatable', Table2,
        'datatable data table database store save keep remember persist rows records sheet spreadsheet excel list log append lookup find read write history state memory register ledger crm between runs across runs shared'),
    // Beside the datatable on purpose: they are the two steps whose effect
    // outlives the run, and somebody looking for one is often reaching for the
    // other. Keyword-rich for the same reason — "save the answer somewhere the
    // agent can find it" is the request, and none of those words name the step.
    stepItem('knowledge_write', 'knowledge_write', BookOpen,
        'knowledge base kb write save store add article document ingest publish knowledgebase agent answer from search rag ground grounding faq wiki handbook remember teach train article writer feed'),
    EDIT_DATA_ITEM,
    stepItem('datetime', 'datetime', Clock,
        'date time datetime format parse add days hours minutes diff extract today now'),
    stepItem('generate_document', 'generate_document', FileText,
        'document pdf word docx file generate make create render export offer quote report letter invoice download attachment print'),
    // The other half of the pair. Its keywords lean on the ARTEFACTS (invoice,
    // quote, letterhead) where generate_document's lean on the FORMAT (pdf,
    // docx, export) — that is the difference an author is searching by.
    stepItem('fill_document', 'fill_document', FileSignature,
        'document fill template invoice factuur quote offerte letter brief letterhead briefpapier pdf merge placeholder design studio print send'),
    // The presentation pair. The slide's keywords are the words of ONE page;
    // the deck's are the words of the artefact and its formats.
    stepItem('slide', 'slide', RectangleHorizontal,
        'slide dia page presentation powerpoint pptx deck bullet bullets title notes speaker'),
    stepItem('presentation', 'presentation', Presentation,
        'presentation presentatie powerpoint pptx deck slides slide pitch keynote impress export download house style huisstijl'),
];

export const COLLECTION_ITEMS = [
    stepItem('limit', 'limit', ChevronsDown,
        'limit take first last slice top head tail trim shorten cap fewer'),
    stepItem('dedupe', 'dedupe', Copy,
        'dedupe duplicates unique distinct same repeated identical once'),
    stepItem('aggregate', 'aggregate', Layers,
        'aggregate collect pluck pick field values flatten column extract list of'),
    stepItem('summarize', 'summarize', Sigma,
        'summarize summarise sum count avg average min max statistics aggregate total add up how many'),
];

// Flow control.
//
// ONE deciding node. If, Switch, "Filter (route)" and "Filter (collection)"
// were four entries for the same question — which of these continues, and
// where does it go? — so they are now a single "Condition" step whose
// editor grows from one rule (an If) to many (a Switch) and can work through
// a list instead of the whole run (a Filter). It starts life as a `condition`;
// flow/routeModel.js swaps the runtime type as the shape changes. The old
// keywords stay so searching "if", "switch" or "filter" still lands here.
//
// The icon is `Split` — one line in, two out, which is what the node does. It
// used to be lucide's `Filter` funnel: the visual language of the Lists group
// this node was deliberately renamed AWAY from, so the picture said "drop some
// rows" while the word said "decide where this goes".
export const ROUTE_ITEM = {
    ...stepItem('condition', 'route', Split, ROUTE_STEP_KEYWORDS),
};

/**
 * Wat er binnen een flowlet/Step of een loop-body niet mag staan — de
 * palet-spiegel van server/automation/validate/constants.js
 * `NESTED_FORBIDDEN_RULES` plus de contract-scope-regels in
 * validate/graph.js. Beide scopes komen hier binnen als `inLayer:true`
 * (BuildTab voor een flowlet, LoopBodyEditor voor een body), en beide weigeren
 * dezelfde drie soorten.
 *
 *   approval / form_page   pauzeren, en hervatten speelt de PARENT-graaf per
 *                          step-id opnieuw af — een pauze in een sub-graaf
 *                          heeft geen adres om op terug te komen.
 *   return_to_app          beëindigt de RUN, en een sub-graaf is niet het
 *                          einde daarvan. In een lus draait hij per item
 *                          opnieuw en levert hij geen runregel op (de app
 *                          krijgt niets); in een parallelle tak beweert hij dat
 *                          de run klaar is terwijl de rest nog draait.
 *
 * Aanbieden wat de validator hard weigert verkoopt de auteur een gegarandeerde
 * fout: hij sleept de stap erin en de eerstvolgende autosave wordt geweigerd —
 * precies de faalvorm die flow/terminalSteps.js benoemt ("de validator weigert
 * een graaf die de editor zojuist heeft laten tekenen"). Daarom FILTEREN, niet
 * disablen: anders dan bij NEEDS_FORM_TRIGGER is er hier geen handeling die de
 * stap alsnog mogelijk maakt zonder de scope te verlaten.
 */
export const NOT_INSIDE_A_LAYER = new Set(['approval', 'form_page', 'return_to_app']);

// A form page is served on the routine's OWN public form URL, so without a
// form trigger there is no page to put it on — server/automation/validate.js
// rejects the definition with `form_page.no_form_trigger`. Adding it anyway
// sells the author a guaranteed validation error.
//
// Shown-but-disabled rather than filtered out: hiding it answered "you can't
// have this" with silence, so the step was simply undiscoverable and the rule
// behind it unknowable (BFSF-348). The reason travels with the item, so every
// surface that renders one can say it.
const NEEDS_FORM_TRIGGER = new Set(['form_page']);
export const NEEDS_FORM_TRIGGER_REASON = 'Form steps run on the routine\'s own form link — switch the trigger to "Form" to use this.';

/**
 * Stamp `disabled` + `disabledReason` on the items whose preconditions the
 * current graph doesn't meet. Items that are fine come back untouched (same
 * object identity), so nothing else re-renders on account of this pass.
 *
 * `hasFormTrigger` is a TRI-STATE: `true` (there is one), `false` (there
 * isn't), and undefined/null — "the caller didn't say". It used to default to
 * `false`, so every surface that forgot to pass it (the "Add step here"
 * popover in BuildTab.jsx) told the author a form step was impossible even
 * when a form trigger was sitting right there in the routine. Only a definite
 * `false` disables: claiming "you can't have this" is a claim, and a surface
 * that doesn't know had better not make it (BFSF-348).
 *
 * Exported so the reco rows ("Suggested next" / "Frequently used"), which are
 * assembled outside buildStepGroups/buildSearchResults, go through the same
 * gate instead of around it.
 */
export function gated(item, hasFormTrigger) {
    if (!NEEDS_FORM_TRIGGER.has(item?.payload?.kind) || hasFormTrigger !== false) return item;
    return { ...item, disabled: true, disabledReason: NEEDS_FORM_TRIGGER_REASON };
}

/**
 * The one Privacy Shield entry (BFSF-355). The label names the FAMILY while the
 * payload names the node a drop creates — the same split the two form entries
 * use. Its keywords are the union of the three entries it replaces, plus the
 * plain-language phrases people actually type: consolidating a feature must not
 * make it unfindable for anyone who searches by what they want to do.
 */
export const PRIVACY_SHIELD_ITEM = {
    ...stepItem('guard', 'privacy_shield', ShieldAlert,
        'guard pii privacy personal data find personal data gdpr avg bsn shield detect scan check find sensitive redact mask compliance '
        + 'tokenize tokenise hide anonymise anonymize pseudonymise placeholder protect before ai '
        + 'untokenize detokenize restore reveal real values unmask unhide back original decode'),
    label: 'Privacy Shield',
    desc: 'Check for personal data, hide it, or show the real values again',
};

// A free-floating canvas annotation (BFSF-411) — never runs, never wired to
// anything. Keywords lean on the words people reach for ("comment",
// "explain", "todo") rather than the runtime type name.
export const NOTE_ITEM = {
    ...stepItem('note', 'note', StickyNote,
        'note sticky note annotation comment memo remark todo explain documentation label text why context'),
};

export const FLOW_CONTROL_ITEMS = [
    ROUTE_ITEM,
    stepItem('loop', 'loop', Repeat,
        'loop foreach iterate array items repeat each every for'),
    // Sits next to Notification because that is what most guards are wired
    // to: "tell me when personal data turns up in this".
    // BFSF-355: ONE Privacy Shield entry. It used to be three — check, hide and
    // reveal — which is three palette items for three stages of one capability,
    // and left the user to know the order. The mode now lives in the node's
    // editor (flow/privacyModel.js); a drop seeds the CHECK mode because it is
    // the only one that changes no data, so an accidental drop cannot alter a
    // value. The label names the FAMILY while the payload names the node a drop
    // creates, so the keywords of all three old entries are kept here: someone
    // searching for 'tokenize', 'unmask' or 'redact' must still land on it, or
    // the consolidation has simply hidden the feature.
    PRIVACY_SHIELD_ITEM,
    // Last: an annotation, not a flow step — it belongs at the end of the
    // list of things you'd reach for to build the routine itself.
    // After the shield, before the note: the design's Flow control order.
    stepItem('stop_error', 'stop_error', OctagonX,
        'stop error throw halt fail abort guardrail end'),
    // The other way a run ends: not badly, but back where it started. Next to
    // Stop-and-Error because they are the two answers to "and then it is over".
    stepItem('return_to_app', 'return_to_app', AppWindow,
        'app studio return back finish screen navigate toast refresh button end done'),
    NOTE_ITEM,
];

/**
 * "People & waiting" (design 1f): every step that suspends the run until a
 * person answers or a clock runs out. They used to sit inside Flow control,
 * which then held ten items with three different jobs.
 */
export const PEOPLE_ITEMS = [
    // Two entries, one step type: for the author these are two different
    // things to reach for, and the editor adapts to which one they picked.
    // Both say "Form" up front: the node they create is called a Form page, and
    // "Ask for more info" on its own told the author nothing about what the
    // step is or why it needs a form trigger (BFSF-348).
    { id: 'form_page', icon: ClipboardList, label: 'Form: ask for more info',
      desc: 'Pause the run and show another form page on the same link',
      keywords: 'form page ask question extra input wait visitor multi step second page human in the loop',
      payload: { kind: 'form_page', mode: 'input', label: 'Ask for more info' } },
    { id: 'form_ending', icon: CheckCircle2, label: 'Form: closing page',
      desc: 'Close the form with a message about what happened',
      keywords: 'form ending summary thanks closing final page result confirmation',
      payload: { kind: 'form_page', mode: 'ending', label: 'Show a summary' } },
    // The human gate. Its keywords carry the words people actually reach for
    // ("sign off", "authorise", "human in the loop"), because someone who
    // wants this rarely searches for the word "approval" first.
    stepItem('approval', 'approval', ShieldCheck,
        'approval approve reject review sign off sign-off signoff authorise authorize permission gate '
        + 'human in the loop wait for a person decision decide ok confirm check by hand manager'),
    stepItem('wait', 'wait', Hourglass,
        'wait sleep delay pause timer hold minutes hours'),
    stepItem('notification', 'notification', Bell,
        'notification notify alert message email tell me'),
];

/** Every flow step, for callers that want the lot (search, usage keys). */
export const LOGIC_ITEMS = [...FLOW_CONTROL_ITEMS, ...PEOPLE_ITEMS];

/**
 * "Integrations" (design 1f): reaching outside the routine — a web service,
 * your own code, and (on the Apps tab) every connected app.
 */
export const INTEGRATION_ITEMS = [
    stepItem('http_request', 'http_request', Globe,
        'http request webhook api call rest fetch get post put patch delete url endpoint web service'),
];

export const CODE_ITEM = {
    ...stepItem('code', 'code', Code, 'code javascript js script custom'),
};

/**
 * Why a code step would be refused, in the author's words.
 *
 * There is no switch for code steps: they run wherever the server has its
 * sandbox. The server answers `flags.code` (a boolean: would a code step RUN
 * here?) and, when that is false, `flags.codeReason`. Today the only reason is
 * 'runtime' (an install without the sandbox); anything else, such as the
 * 'platform' or 'org' an older server may still send, reads as 'unknown'.
 *
 * English, not t(): the sentence beside it (NEEDS_FORM_TRIGGER_REASON) is
 * English too, and adding keys here means adding them to both dictionaries,
 * which is outside this change. Same debt, same place, one round to pay it.
 */
export const CODE_OFF_REASONS = {
    runtime: 'This server was installed without the code sandbox, so a code step could not run here.',
    unknown: 'This server did not say whether it can run code steps, so a code step could still be refused when it runs.',
};

/**
 * The Code entry as the catalog allows it: addable, inert-with-a-reason, or
 * absent — a TRI-STATE, for the same reason `gated()`'s `hasFormTrigger` is one
 * (BFSF-348).
 *
 *   flags.code === true    the server asked all three of the runner's
 *                          questions and they all said yes → the real item.
 *   flags.codeReason set   a definite NO, with the reason → the item, DISABLED,
 *                          carrying the sentence. Shown rather than dropped:
 *                          a missing entry answers "can Bee Flow run my own
 *                          code?" with silence, so the capability is
 *                          undiscoverable and the rule behind it unknowable —
 *                          exactly what the form pages were fixed out of.
 *   neither                nothing loaded the catalog yet, or an older server
 *                          that sends no reason. The surface does not KNOW, so
 *                          it makes no claim and offers nothing — the old
 *                          behaviour, unchanged.
 *
 * NOTE for anyone widening this: `flags.code` must stay a boolean. It is read
 * for truthiness here and turning it into an object (`{platform, org}`) would
 * make it always truthy and open the gate it exists to close. The reason rides
 * in its own field for that reason.
 */
export function codeItemFor(catalog) {
    // `=== true`, not truthiness. The flag is a boolean by contract, and the
    // one way this gate gets silently re-opened is somebody widening it into
    // an object ({platform:true, org:false}) on the server: every `if
    // (flags.code)` in this file would then pass forever, for every org,
    // including the ones the object was added to EXCLUDE. Insisting on the
    // literal true makes that mistake fail loudly here instead.
    if (catalog?.flags?.code === true) return CODE_ITEM;
    const reason = catalog?.flags?.codeReason;
    if (!reason) return null;
    return { ...CODE_ITEM, disabled: true, disabledReason: CODE_OFF_REASONS[reason] || CODE_OFF_REASONS.unknown };
}

export const CREATE_LAYER_ITEM = {
    id: '__create_layer', icon: Layers, label: 'Create flowlet', desc: 'Group steps into a reusable sub-flow',
    keywords: 'flowlet create new subflow sub-automation group reusable', payload: { kind: 'create_layer' },
};

export const LAYER_OUTPUT_ITEM = {
    ...stepItem('layer_output', '__layer_output', LogOut, 'flowlet output return result respond finish end'),
};

export const CATEGORY_ORDER = [...INTEGRATION_CATEGORY_ORDER, OTHER_CATEGORY];

// ─── Dynamic item builders ──────────────────────────────────────────────
export function inlineLayerItem(l) {
    const nParams = (l.params || []).length;
    return {
        id: l.key, icon: Layers, label: l.title || l.key,
        desc: `${nParams} input${nParams === 1 ? '' : 's'}`,
        keywords: 'flowlet subflow sub-automation reusable group',
        payload: { kind: 'call_layer', layerKey: l.key, label: l.title || l.key },
    };
}

export function blockItem(b) {
    const nIn = (b.params || []).length;
    const nOut = (b.outputFields || []).length;
    // "2 in · 3 out" was the WHOLE palette line for a reusable Step. An arity
    // is a fact about a function signature, never about what the thing is FOR,
    // so this was the one group in the menu that told its reader nothing —
    // and it is exactly the slot the "build your own Step" story wants to
    // fill, where a library one person writes has to stay readable to the
    // colleague who inherits it. The server has shipped each Step's own
    // `description` all along (server/routes/automation/catalog.js maps it
    // straight off the Step row) and this builder threw it away. So the
    // author's sentence leads and the counts trail it as the supporting
    // detail they are — demoted, not deleted, because "does this take the
    // three things I have?" is a real question at the moment of picking.
    //
    // Same sanitizer as an app action's blurb (uiDescription): a Step meant to
    // be callable by an AI agent tends to carry "call this first"-style
    // wording that has no business in a menu a person reads.
    const blurb = uiDescription(b.description);
    const arity = `${nIn} input${nIn === 1 ? '' : 's'} · ${nOut} output${nOut === 1 ? '' : 's'}`;
    // Show the Step's own symbol in the palette (resolve its Lucide name to a
    // component), falling back to the generic Box.
    return {
        id: `block_${b.id}`, icon: STEP_ICON_MAP[b.icon] || Box, label: b.title || 'Step',
        desc: blurb ? `${blurb} · ${arity}` : arity,
        // The description is searchable too (bucket 3, via `keywords`): someone
        // who remembers what a Step DOES but not what a colleague named it had
        // no way in at all.
        keywords: `step block reusable building-block call ${b.title || ''} ${blurb}`.trim(),
        payload: { kind: 'call_block', blockId: b.id, label: b.title || 'Step', icon: b.icon || null },
    };
}

export function prettifyToolName(name) {
    return name ? String(name).replace(/_/g, ' ') : '';
}

const UNCATEGORISED = 'Uncategorised';

/**
 * Group reusable Steps into the user-set categories shown in the add-step
 * menu's "Steps" dropdown. Returns section descriptors ({key,title,items}) —
 * named categories alphabetical, the catch-all ('Uncategorised') last.
 */
export function groupBlocksByCategory(blocks) {
    const map = new Map();
    for (const b of blocks) {
        const cat = (b.category && b.category.trim()) || UNCATEGORISED;
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat).push(b);
    }
    const cats = [...map.keys()].sort((a, c) => {
        if (a === UNCATEGORISED) return 1;
        if (c === UNCATEGORISED) return -1;
        return a.localeCompare(c);
    });
    return cats.map(cat => ({
        key: `step_cat_${cat}`,
        title: cat,
        items: map.get(cat)
            .slice()
            .sort((x, y) => (x.title || '').localeCompare(y.title || ''))
            .map(blockItem),
    }));
}

function normalizeId(id) {
    return String(id || '').toLowerCase().replace(/-/g, '_');
}

function buildCategoryMap() {
    const map = new Map();
    for (const entry of INTEGRATION_CATALOG) map.set(normalizeId(entry.id), entry);
    return map;
}

// Where an app with no explicit `rank` sorts: after every ranked one, then
// alphabetically among its unranked peers. So a category nobody has ordered by
// hand keeps the plain A→Z it has always had.
const UNRANKED = 1000;

/**
 * Group the catalog's apps by integration category →
 * [{id,label,shortLabel,integrationId,actions,connected}].
 *
 * `shortLabel` is what the ribbon prints on the button; `label` stays full and
 * is what lands in the node payload. Ordering is by the catalog's `rank` then
 * by the SHORT label, so the visible order is the alphabetical order of the
 * text actually on screen.
 */
export function groupAppsByCategory(catalog) {
    if (!catalog?.apps) return {};
    const catMap = buildCategoryMap();
    const out = {};
    for (const a of catalog.apps) {
        if (!a.available) continue;
        const allActions = (a.actions || []).map(act => ({
            kind: 'integration_action',
            tool: act.name,
            label: act.label || prettifyToolName(act.name),
            description: act.description,
            integrationId: act.integrationId || resolveIntegrationFromTool(act.name) || a.id,
            sideEffect: act.sideEffect,
        }));
        if (allActions.length === 0) continue;
        const integrationId = allActions[0].integrationId || a.id;
        const known = catMap.get(normalizeId(a.id)) || catMap.get(normalizeId(integrationId)) || null;
        const category = known?.category || OTHER_CATEGORY;
        const entry = {
            id: a.id,
            label: a.label,
            shortLabel: shortAppLabel(a.label, category, normalizeId(a.id)),
            rank: Number.isFinite(known?.rank) ? known.rank : UNRANKED,
            integrationId,
            actions: allActions,
            connected: a.connected !== false,
        };
        (out[category] = out[category] || []).push(entry);
    }
    for (const k of Object.keys(out)) {
        out[k].sort((x, y) => (x.rank - y.rank) || x.shortLabel.localeCompare(y.shortLabel));
    }
    return out;
}

/** Ordered apps list flattened across categories (for the Action dropdown). */
export function orderedAppCategories(catalog) {
    const grouped = groupAppsByCategory(catalog);
    return CATEGORY_ORDER
        .map(cat => ({ category: cat, apps: grouped[cat] || [] }))
        .filter(g => g.apps.length > 0);
}

/**
 * Build the ordered groups the ribbon + menu render. Each group is one of:
 *   { key, title, items: Item[] }                              — flat group
 *   { key:'action', title, kind:'apps', categories:[{category,apps}] }
 *   { key:'flow',  title, kind:'sections', sections:[{key,title,items}] }
 * Flow control + Data & lists + Code are consolidated into the single "Flow"
 * group (as category sections) so the builder isn't hunting across several
 * overlapping menus. `opts`: { catalog, layers, inLayer, canAddLayerOutput, isBlockRoot }.
 *
 * `mode:'trigger'` is the empty canvas ("Choose a trigger"). Only a trigger can
 * legally go first, so only triggers are offered — BROWSE now says what SEARCH
 * has always said (buildSearchResults' identical branch below). Until BFSF-367
 * this path fell through to the full menu, which put "Suggested next" (AI step,
 * Edit data, Notification — none of them placeable yet) above the one section
 * that could be used. Bare TRIGGERS, not additionalTriggerItems(): with no
 * trigger to replace, "Replaces the current trigger" describes nothing.
 */
export function buildStepGroups({ catalog = null, mode = 'step', layers = [], inLayer = false, canAddLayerOutput = false, isBlockRoot = false, canCreateLayer = true, hasFormTrigger = null, t = null } = {}) {
    if (mode === 'trigger') return [{ key: 'triggers', title: 'Trigger', items: TRIGGERS }];
    const blocks = isBlockRoot ? [] : (catalog?.steps || []).filter(s => s && s.available !== false);
    // canCreateLayer:false (loop-body editor, B8): "Create flowlet" is a
    // scope-spanning meta-action only BuildTab.handleAddNode can perform —
    // buildStepFromPayload returns null for it, so offering it in the body's
    // Add-step menu was a guaranteed dead click.
    const flowlets = [
        ...(canAddLayerOutput ? [localised(LAYER_OUTPUT_ITEM, t)] : []),
        ...(canCreateLayer ? [CREATE_LAYER_ITEM] : []),
        ...(layers || []).map(inlineLayerItem),
    ];
    const codeItem = codeItemFor(catalog);
    const flowSections = [
        // The four content sections of the design's Home tab (1f). Every step
        // has exactly ONE of them — stepPalette.oneHome.test.js proves it.
        // Beide secties door hetzelfde filter: `return_to_app` zit in Flow
        // control en die sectie ging ONGEFILTERD door, dus de loop-body- en
        // flowlet-editor boden "Back to the app" aan terwijl de validator hem
        // daar hard weigert.
        { key: 'flow_control', title: t ? t('routines.node.group.flow_control', 'Flow control') : 'Flow control',
          items: FLOW_CONTROL_ITEMS.filter(it => !inLayer || !NOT_INSIDE_A_LAYER.has(it.payload.kind)).map(it => localised(it, t)) },
        { key: 'people', title: t ? t('routines.node.group.people', 'People & waiting') : 'People & waiting',
          items: PEOPLE_ITEMS.filter(it => !inLayer || !NOT_INSIDE_A_LAYER.has(it.payload.kind)).map(it => localised(gated(it, hasFormTrigger), t)) },
        // ONE data section. "Data" and "Lists" sat next to each other with no
        // line an author could draw between them (BFSF-361), so they are one
        // group, ordered records-first then whole-list operations.
        { key: 'data', title: t ? t('routines.node.group.data_lists', 'Data & lists') : 'Data & lists',
          items: [...DATA_ITEMS, ...COLLECTION_ITEMS].map(it => localised(it, t)) },
        { key: 'integrations', title: t ? t('routines.node.group.integrations', 'Integrations') : 'Integrations',
          // codeItemFor, not `flags.code` directly: the entry is also offered
          // DISABLED, with the reason the server gave, when a code step would
          // be refused at run time.
          items: [...INTEGRATION_ITEMS, ...(codeItem ? [codeItem] : [])].map(it => localised(it, t)) },
    ];
    const groups = [
        // Browsing has to find triggers too — search alone would still leave a
        // user who doesn't know the word "trigger" stuck (BFSF-325).
        ...(!inLayer && !isBlockRoot ? [{ key: 'triggers', title: 'Trigger', items: additionalTriggerItems() }] : []),
        { key: 'ai', title: 'AI', items: AI_ITEMS.map(it => localised(it, t)) },
        { key: 'action', title: 'Action', kind: 'apps', categories: orderedAppCategories(catalog) },
        { key: 'flow', title: 'Flow', kind: 'sections', sections: flowSections },
        // Skip an EMPTY flowlets group (loop-body editor with no flowlets and
        // canCreateLayer off) — an empty heading reads as a broken menu.
        ...(flowlets.length ? [{ key: 'flowlets', title: 'Flowlets', items: flowlets }] : []),
    ];
    if (blocks.length > 0) {
        const sections = groupBlocksByCategory(blocks);
        // A single uncategorised bucket reads better flat (no redundant heading);
        // otherwise show one sub-heading per category.
        const flat = sections.length === 1 && sections[0].title === UNCATEGORISED;
        groups.push(flat
            ? { key: 'steps', title: 'Steps', items: sections[0].items }
            : { key: 'steps', title: 'Steps', kind: 'sections', sections });
    }
    return groups;
}

/** Look up a catalog item by id from a flat item list (for ribbon inline buttons). */
export function pickItem(items, id) {
    return (items || []).find(it => it.id === id) || null;
}

const ALL_STATIC_ITEMS = [...AI_ITEMS, ...DATA_ITEMS, ...COLLECTION_ITEMS, ...LOGIC_ITEMS, ...INTEGRATION_ITEMS, CODE_ITEM];

/**
 * Resolve a stepUsage usage-key ('step:loop', 'action:gmail_send',
 * 'flowlet:<key>', 'block:<id>', 'layer:create') back to a render-ready
 * search-result item ({key, Icon|integrationId+tool, label, secondary, payload})
 * for the smart "Suggested" / "Frequently used" sections — or null if it can't
 * be resolved in the current scope (app unavailable, deleted flowlet, etc.).
 */
export function itemForKey(key, { catalog = null, layers = [] } = {}) {
    if (!key || typeof key !== 'string') return null;
    const i = key.indexOf(':');
    if (i < 0) return null;
    const type = key.slice(0, i);
    const rest = key.slice(i + 1);
    const asResult = (it) => (it
        ? { key: it.id, Icon: it.icon, label: it.label, secondary: it.desc, payload: it.payload }
        : null);

    // Triggers used to resolve to null here, so a trigger a user reaches for
    // every day could never come back as a suggestion (BFSF-325).
    if (type === 'trigger') return asResult(additionalTriggerItems().find(t => t.payload.triggerKind === rest));

    if (type === 'step') {
        // The four merged deciding steps keep their recorded usage: whichever
        // of them a user reached for, the one Filter item is what we
        // now offer back.
        if (rest === 'condition' || rest === 'switch' || rest === 'filter' || rest === 'filter_route') return asResult(ROUTE_ITEM);
        // Parse JSON left the palette; its ability lives in Edit data now, so
        // recorded usage keeps resolving to something addable.
        if (rest === 'parse_json') return asResult(EDIT_DATA_ITEM);
        // Same for the three privacy steps merged into one node (BFSF-355):
        // whichever stage a user reached for, the Privacy Shield item is what
        // comes back — otherwise every recorded 'step:tokenize' in the usage
        // history would silently stop resolving and quietly drop out of
        // "Frequently used".
        if (rest === 'guard' || rest === 'tokenize' || rest === 'untokenize') return asResult(PRIVACY_SHIELD_ITEM);
        // Code is the one static item whose availability the SERVER decides
        // (codeItemFor above: is the sandbox installed). These rows
        // resolved it straight out of ALL_STATIC_ITEMS, with no flag consulted
        // at all, so the "Frequently used" shortcut kept handing out an
        // addable Code step on an install whose runs execCode refuses: the
        // same trap the palette listing was fixed for, reached one row higher
        // up. It only takes a user who used code steps on another install
        // or before an upgrade that dropped the sandbox.
        //
        // Dropped rather than stamped `disabled`: the reco rows render in two
        // places, and only one of them honours the stamp. AddStepMenu's
        // SearchResultRow does (it is the same row the search uses), but
        // AddStepRibbon's "Frequent" cluster maps these items straight into an
        // always-clickable, always-draggable CmdButton — a disabled Code entry
        // there would still add the step. Until that row learns the stamp, not
        // offering the shortcut is the only answer that is true on BOTH
        // surfaces, and the step itself stays visible-with-its-reason in the
        // palette's Integrations section, which is where the capability and
        // the rule behind it are meant to be discoverable (BFSF-348).
        if (rest === 'code') {
            const code = codeItemFor(catalog);
            return (!code || code.disabled) ? null : asResult(code);
        }
        return asResult(ALL_STATIC_ITEMS.find(x => x.id === rest) || ALL_STATIC_ITEMS.find(x => x.payload.kind === rest));
    }
    if (type === 'layer' && rest === 'create') return asResult(CREATE_LAYER_ITEM);
    if (type === 'flowlet') {
        const l = (layers || []).find(x => x.key === rest);
        return l ? asResult(inlineLayerItem(l)) : null;
    }
    if (type === 'block') {
        const b = (catalog?.steps || []).find(x => String(x.id) === rest && x.available !== false);
        return b ? asResult(blockItem(b)) : null;
    }
    if (type === 'action') {
        for (const a of (catalog?.apps || [])) {
            if (a.available === false) continue;
            const act = (a.actions || []).find(x => x.name === rest);
            if (!act) continue;
            const integrationId = act.integrationId || resolveIntegrationFromTool(act.name) || a.id;
            const label = act.label || prettifyToolName(act.name);
            const labels = actionLabelMap((a.actions || []).map(x => ({ tool: x.name, label: x.label })));
            return {
                key: act.name, Icon: null, integrationId, tool: act.name,
                label: labels.get(act.name) || label, secondary: a.label,
                payload: { kind: 'integration_action', tool: act.name, label, appId: integrationId, sideEffect: act.sideEffect },
            };
        }
        return null;
    }
    return null;
}

/**
 * Flat ranked search across every addable thing. Returns DATA only
 * (Icon = lucide component or null + integrationId/tool for app logos) —
 * the renderer builds the actual icon element. Buckets:
 *   0 exact label · 1 label startsWith · 2 label includes · 3 desc/keywords/tool includes
 */
export function buildSearchResults(query, { catalog = null, mode = 'step', layers = [], inLayer = false, canAddLayerOutput = false, isBlockRoot = false, hasFormTrigger = null, t = null } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const blocks = isBlockRoot ? [] : (catalog?.steps || []).filter(s => s && s.available !== false);
    const candidates = [];

    const pushItem = (it, context) => candidates.push({
        key: it.id, Icon: it.icon, label: it.label, secondary: it.desc,
        keywords: it.keywords, context, payload: it.payload,
        // Carried through so a result the current graph can't accept renders
        // inert-with-a-reason instead of vanishing from the search.
        ...(it.disabled ? { disabled: true, disabledReason: it.disabledReason } : null),
    });

    if (canAddLayerOutput) pushItem(localised(LAYER_OUTPUT_ITEM, t), 'Flowlet');

    if (mode === 'trigger') {
        // Empty canvas: the pick SEEDS the one primary trigger, so nothing
        // else is on offer yet.
        for (const t of TRIGGERS) pushItem(t, 'Trigger');
        return rank(candidates, q);
    }

    // Triggers stay findable once the routine has one — they are the first
    // thing a user searches for and used to return nothing (BFSF-325). Not
    // inside a flowlet (its trigger IS its input contract) or a loop body /
    // block root, where buildStepFromPayload rejects them anyway.
    if (!inLayer && !isBlockRoot) {
        for (const t of additionalTriggerItems()) pushItem(t, 'Trigger');
    }

    for (const it of AI_ITEMS) pushItem(localised(it, t), 'AI');
    for (const it of DATA_ITEMS) pushItem(localised(it, t), 'Data');
    for (const it of INTEGRATION_ITEMS) pushItem(localised(it, t), 'Integrations');
    for (const it of COLLECTION_ITEMS) pushItem(localised(it, t), 'Collection');
    for (const it of LOGIC_ITEMS) {
        if (inLayer && NOT_INSIDE_A_LAYER.has(it.payload.kind)) continue;
        pushItem(localised(gated(it, hasFormTrigger), t), 'Flow');
    }
    // Same tri-state as the browse groups: addable, inert-with-a-reason (the
    // search already carries `disabled`/`disabledReason` through pushItem), or
    // — when the catalog says nothing — absent.
    const codeItem = codeItemFor(catalog);
    if (codeItem) pushItem(localised(codeItem, t), 'Code');
    for (const l of (layers || [])) pushItem(inlineLayerItem(l), 'Flowlet');
    for (const b of blocks) pushItem(blockItem(b), (b.category && b.category.trim()) || 'Step');

    if (catalog?.apps) {
        for (const a of catalog.apps) {
            if (!a.available) continue;
            // Shown as "List rooms" with "Nextcloud Talk" underneath, rather
            // than "nextcloud talk list rooms" with "Nextcloud Talk" underneath.
            // Still findable by the app name: `secondary` and `tool` are both
            // ranked (bucket 3), so typing "nextcloud" or "talk" matches.
            const labels = actionLabelMap((a.actions || []).map(act => ({ tool: act.name, label: act.label })));
            for (const act of (a.actions || [])) {
                const integrationId = act.integrationId || resolveIntegrationFromTool(act.name) || a.id;
                const label = act.label || prettifyToolName(act.name);
                candidates.push({
                    key: act.name, Icon: null, integrationId, tool: act.name,
                    label: labels.get(act.name) || label,
                    secondary: a.label, description: act.description, context: a.label,
                    // The payload label is the FULL name: a node on the canvas
                    // has nothing next to it to say which app it belongs to.
                    payload: { kind: 'integration_action', tool: act.name, label, appId: integrationId, sideEffect: act.sideEffect },
                });
            }
        }
    }

    return rank(candidates, q);
}

/**
 * Words a search phrase may contain without having to match anything.
 *
 * Deliberately short: only connectives, nothing that could ever be the thing
 * someone is looking for. "of" is in both languages and means different things
 * in each ("or" in Dutch), which is exactly why it carries no signal here.
 */
const SEARCH_STOP_WORDS = new Set('a an the to of in on at for and or with from into by een de het naar van op voor en met uit bij om dat die'.split(' '));

/**
 * A phrase has to work. Every bucket in rank() matches the WHOLE query as one
 * substring, so "send an email" scored nothing at all — no label, description
 * or keyword string holds those three words in that order — and the palette
 * answered "No matches" for a step that exists twice over. The keyword corpus
 * above is deliberately rich ("KEYWORDS ARE NOT DECORATION") and a multi-word
 * query threw all of it away, which is the shape most people type.
 *
 * Returns a predicate over one candidate's searchable text. It answers false
 * for a SINGLE-word query, so those rank exactly as they always did, and
 * false when every word is a connective — `[].every()` is true, so "the"
 * would otherwise match the whole palette. Connectives are dropped rather
 * than required: nothing anywhere contains "an", so requiring it put the
 * query straight back to "No matches".
 */
function wordMatcher(q) {
    const all = q.split(/\s+/).filter(Boolean);
    const words = all.filter(tok => !SEARCH_STOP_WORDS.has(tok));
    if (all.length < 2 || !words.length) return () => false;
    // EVERY word must land, or "send email" would surface everything that
    // merely mentions "send".
    return (hay) => words.every(tok => hay.includes(tok));
}

function rank(candidates, q) {
    // Bucket 4 (see wordMatcher) is additive and LAST: every whole-query
    // bucket keeps its meaning and its order, so nothing that matched
    // before matches differently now. It only adds results that used to
    // be silence.
    const byWord = wordMatcher(q);
    const ranked = [];
    for (const c of candidates) {
        const label = (c.label || '').toLowerCase();
        const desc = (c.secondary || c.description || '').toLowerCase();
        const tool = (c.tool || '').toLowerCase();
        const kw = (c.keywords || '').toLowerCase();
        let bucket = -1;
        if (label === q) bucket = 0;
        else if (label.startsWith(q)) bucket = 1;
        else if (label.includes(q)) bucket = 2;
        else if (desc.includes(q) || kw.includes(q) || tool.includes(q)) bucket = 3;
        // Joined with spaces so a word can never straddle two fields.
        else if (byWord(`${label} ${desc} ${kw} ${tool}`)) bucket = 4;
        if (bucket === -1) continue;
        ranked.push({ ...c, _bucket: bucket });
    }
    ranked.sort((a, b) => a._bucket - b._bucket);
    return ranked;
}
