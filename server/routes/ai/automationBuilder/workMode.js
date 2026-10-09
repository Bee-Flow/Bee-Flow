const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { MUTATING_TOOLS, findStepAnywhere } = require('../../../automation/builderTools');
const { lookupTable, normaliseKey } = require('../../../automation/builderTools/datatableRefs');
const { normaliseFieldArgs } = require('../../../automation/builderTools/datatableCreate');
const { boundDatatableIds } = require('../../../automation/builderTools/pendingDatatables');
const { parseAnswersText } = require('../../../automation/builderTools/questionAnswers');

// These tools only inspect the draft, a schema or the document library. Unknown
// tools fail closed.
//
// builder_search_documents / builder_read_document are READ tools and belong
// here: documentDiscovery.inspectBindings refuses a fill_document step until
// builder_read_document ran for its document, and the "Documents you may fill"
// block tells the model to call the search. They were in neither set below, so
// in the default work mode ("Approve each change") fill_document could never be
// built: the refusal named a tool the mode did not offer.
const READ_TOOLS = new Set(['builder_inspect_tool', 'builder_summarise',
    'builder_ask_questions', 'builder_write_plan', 'builder_inspect_step', 'builder_inspect_mapping', 'builder_inspect_run',
    'builder_search_documents', 'builder_read_document',
    'webpages_list', 'webpage_db_schema', 'webpage_db_query', 'webpage_file_read',
    // Web research (webResearch.js): reads the web, never the draft.
    'agent_search', 'read_url']);
// A dry run is how a proposal is CHECKED, so approve and plan mode may run one:
// it executes the staged definition without saving it (builderTools:
// draftWrap._stagedDryRun) and the runner simulates every side-effect step
// (sideEffectMap, mode 'dry_run'); read-only steps run for real, as in a build.
// Not in discuss mode, which promises to touch nothing.
const STAGED_CHECK_TOOLS = new Set(['builder_request_dry_run']);
// Real, outside-the-draft effects a preview must not have: finalize saves, the
// flowlet tools spend a sub-agent's work on a draft the user has not accepted.
// builder_create_datatable is NOT here: in a preview it STAGES the table in the
// proposal (a "pending:<n>" id, created on Apply) instead of making one, so it
// has an explicit branch in toolAllowed. It is also not in MUTATING_TOOLS on
// purpose: it changes no graph, so it gets no `scope` parameter and no
// persist-and-emit after the call.
const PREVIEW_BLOCKED = new Set(['builder_finalize',
    'builder_generate_layer', 'builder_generate_layers']);
// builder_set_plan is the to-do CHECKLIST of a build. It was a read tool, so
// Plan first offered it beside builder_write_plan and the model "planned" with
// the checklist: a card with no Build button. In Plan first the plan is
// builder_write_plan and nothing else; the checklist belongs to a build.
const CHECKLIST_TOOLS = new Set(['builder_set_plan']);
const MODES = ['discuss', 'approve', 'plan', 'build'];

// One question round holds at most this many questions, each with at most this
// many answers. More are cut, never rejected: a rejected call cost a round and
// the user waited for nothing.
const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 4;

// An approved plan that says "remove the X step" is the human's decision to
// remove it, taken on a reviewed document, so the build turn that executes it
// may call builder_remove_step. The words are the plan's; the SCOPE is checked
// per call (planCoversRemoval): only a step the same plan line names.
const REMOVAL_WORDS = /\b(remove|delete|drop|discard|get rid of|verwijder\w*|haal\w* weg|schrap\w*|laat\w* vervallen)\b/i;

function planStepLines(plan) {
    return Array.isArray(plan?.steps) ? plan.steps.filter(s => typeof s === 'string') : [];
}

/** Does the approved plan contain a removal at all? Decides whether the tool is offered. */
function planMentionsRemoval(plan) {
    return planStepLines(plan).some(line => REMOVAL_WORDS.test(line));
}

// A plan line is read clause by clause, because one line often says both what
// goes and what stays ("Remove the old Slack ping; Send email stays as is"). A
// clause that also says keep never covers a removal: the check fails closed and
// the human approves the removal separately. The split before a keep word keeps
// "Remove the Slack ping and keep Send email" usable for the first half.
const KEEP_WORDS = /\b(keep|keeps|kept|stay|stays|leave|leaves|retain|retains|preserve|preserves|unchanged|untouched|as is|behoud\w*|blijft|blijven|laat\w* staan)\b/i;
const CLAUSE_SPLIT = /[;\n]|\.\s|\b(?:but|while|whereas|however)\b|\b(?:and\s+)?(?=(?:keep|keeps|leave|leaves|retain|retains|preserve|preserves|behoud\w*)\b)/i;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The name must stand alone as a phrase: "x_7" is not inside "x_71" and the
// label "Send" is not inside "Resend".
function namesPhrase(text, phrase) {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

/**
 * May THIS step be removed under the approved plan? Only when one plan clause
 * says remove, does not say keep, and names the step as a whole phrase, by id or
 * by its label. A removal the plan never mentioned still needs a separate
 * human-approved proposal.
 */
function planCoversRemoval(plan, step) {
    if (!step) return false;
    const id = typeof step.id === 'string' ? step.id.trim() : '';
    const label = typeof step.label === 'string' ? step.label.trim() : '';
    return planStepLines(plan).some(line => line.split(CLAUSE_SPLIT).some((clause) => {
        if (!clause || !REMOVAL_WORDS.test(clause) || KEEP_WORDS.test(clause)) return false;
        return (id && namesPhrase(clause, id)) || (label.length >= 3 && namesPhrase(clause, label));
    }));
}

/**
 * The step (or additional trigger) a builder_remove_step call would remove, found
 * in the graph the call changes: builderTools resolves `scope` to
 * definition.layers[scope], so the lookup must too, or a flowlet step is missed
 * (and a root step with the same id is judged instead). Null when it does not
 * exist there.
 */
function resolveRemovalTarget(def, args) {
    const stepId = args?.stepId;
    if (!def || typeof stepId !== 'string') return null;
    const scope = typeof args?.scope === 'string' && args.scope ? args.scope : null;
    const graph = scope ? def.layers?.[scope] : def;
    if (!graph || typeof graph !== 'object') return null;
    return findStepAnywhere(graph, stepId)?.step
        || [graph.trigger, ...(Array.isArray(graph.triggers) ? graph.triggers : [])].find(t => t && t.id === stepId)
        || null;
}

// `opts.planAllowsRemoval`: the turn executes an approved plan that contains a
// removal (planMentionsRemoval). The per-step check is planCoversRemoval.
function toolAllowed(name, mode, { planAllowsRemoval = false } = {}) {
    if (mode === 'build') return name !== 'builder_remove_step' || planAllowsRemoval;
    // Approve mode stages the table (see PREVIEW_BLOCKED). Plan and discuss
    // only describe it: plan puts it in builder_write_plan's `datatables`.
    if (name === 'builder_create_datatable') return mode === 'approve';
    if (CHECKLIST_TOOLS.has(name)) return mode === 'approve';
    if (READ_TOOLS.has(name)) return true;
    if (STAGED_CHECK_TOOLS.has(name)) return mode === 'approve' || mode === 'plan';
    return mode === 'approve' && MUTATING_TOOLS.has(name) && !PREVIEW_BLOCKED.has(name);
}

// What the model reads when a tool is refused in a work mode. A table in Plan
// first is the one refusal with a better answer than the generic line: the
// table belongs in the plan, and is created when the user approves it and the
// build runs.
function previewRefusal(name, mode) {
    if (name === 'builder_create_datatable' && mode === 'plan') {
        return 'No table was created in Plan first. Put it in builder_write_plan\'s "datatables" list (name and typed columns); it is created when the user approves the plan and the build runs.';
    }
    if (CHECKLIST_TOOLS.has(name) && (mode === 'plan' || mode === 'discuss')) {
        return 'In Plan first the plan is builder_write_plan; the checklist is only for building. Do not track progress in this turn.';
    }
    return `This tool is not permitted in ${mode} mode. Read, explain or propose a plan instead. Removing a step needs a human-approved proposal.`;
}

// builder_ask_questions draws a card in the chat. A model that also writes the
// questions in its message shows them twice, once as a list and once as the
// card, and the user answers on the card. The rule sits in the work-mode
// instruction and in the tool description, because a small model reads one of
// the two at best.
const QUESTIONS_RULE = 'When you call builder_ask_questions, do NOT write the questions or their options in your message: the chat shows them as a card. '
    + 'Say at most one short sentence before the call. Keep each question to one short sentence and each option to a few words; no lists or headings inside them, inline markdown (bold, code) only. '
    + 'Before calling builder_ask_questions, collect EVERY open question and ask them in that one call. Do not ask what you can read from the draft, the catalog or the documents.';

// Binding a step to somebody's real table is the user's call (datatableApproval).
const TABLE_CONSENT_RULE = 'Bind a step to an EXISTING table only when the user named or picked it, or the flow already uses it. Otherwise call builder_ask_questions with datatableIds (the fitting tables) and createLabel, then wait.';

function modeInstruction(mode, plan = null) {
    return withTableRule(modeBody(mode, plan));
}

const withTableRule = (text) => `${text} ${TABLE_CONSENT_RULE}`;

function modeBody(mode, plan = null) {
    const common = '\nASSISTANT WORK MODE (overrides build-first instructions and examples above): ';
    if (mode === 'discuss') return common + 'DISCUSS ONLY. Explain and advise. Read the draft and schemas. Never change anything. Ask only questions you cannot infer from the available context. ' + QUESTIONS_RULE;
    if (mode === 'plan') return common + 'PLAN FIRST. Explore the draft and schemas without changing anything. You may read the document library (builder_search_documents, builder_read_document) and run builder_request_dry_run on the current draft (side effects are simulated) when the plan depends on what they return. '
        + 'If something essential is unclear, ask ALL your questions in ONE builder_ask_questions call; you get one question round for this plan. Otherwise go straight to builder_write_plan. ' + QUESTIONS_RULE + ' '
        + 'Do not call builder_set_plan and do not track progress: nothing is built in this turn. End this turn with exactly one of: builder_ask_questions or builder_write_plan. Only answer in prose when the user merely asked a question. '
        + 'builder_write_plan takes a readable title, goal, assumptions, steps, prerequisites and tests. '
        + 'Write every line of the plan as one plain sentence, without numbering or bullet characters: the plan view numbers the steps itself. Wait for explicit plan approval. A todo checklist is not approval. Never build in this turn. '
        + 'List new tables (name and typed columns) in builder_write_plan.datatables and the existing tables you will use in useDatatables.';
    if (mode === 'approve') return common + 'PROPOSE CHANGES. Draft tools change an isolated preview only. Describe exactly what changed, including field mappings (old → new), and why. Do not claim changes are applied. The human applies or discards the proposal. '
        + 'Check your proposal before you describe it: builder_request_dry_run runs the STAGED definition without saving it and simulates every side effect (nothing is sent or written; reads run for real). '
        + 'A NEW table: call builder_create_datatable as usual. In a preview it is STAGED: you get datatableId "pending:<n>" — use it (with its datatableKey) exactly like a real id. The table and its columns are shown in the proposal and created only when the user presses Apply; say so, never that it exists. '
        + 'To change a step\'s TYPE (e.g. a Nextcloud Tables action into a Bee Flow table step) use builder_replace_step with newType:"datatable".';
    return common + 'BUILD DIRECTLY. Make changes visible. Removing a step requires a separate human-approved proposal'
        + (planMentionsRemoval(plan) ? ', except a step this approved plan names for removal' : '')
        + '. Never activate or publish. '
        + (plan ? `The user has APPROVED this plan: build it now, do not wait for approval again. Follow this approved plan; report any deviation and ask before changing its scope: ${JSON.stringify(plan)}. `
            + 'The checklist is the approved plan\'s steps; mark them done with builder_set_plan({markDone}) and do not replace the list. '
            + 'If the plan asks to fold a flowlet into the main flow, use builder_inline_layer. When the last step is done, say the plan is complete.' : '');
}

const PLAN_TOOL = { type: 'function', function: {
    name: 'builder_write_plan', description: 'Write or revise the plan for human review. Does not modify the automation. Build only after the human approves this exact revision.',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'goal', 'steps'], properties: {
        title: { type: 'string' }, goal: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', description: 'One plain sentence per step, without numbering or bullet characters: the plan view numbers them.', items: { type: 'string' } },
        prerequisites: { type: 'array', items: { type: 'string' } },
        tests: { type: 'array', items: { type: 'string' } },
        datatables: { type: 'array', maxItems: 5, description: 'NEW tables the plan creates once the user approves it: name and typed columns. The build creates exactly these. Do not list a table that already exists.', items: { type: 'object', additionalProperties: false, required: ['name', 'fields'], properties: {
            name: { type: 'string' }, description: { type: 'string' },
            fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: {
                name: { type: 'string' }, type: { type: 'string', enum: ['text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'file'] },
                options: { type: 'array', items: { type: 'string' } }, required: { type: 'boolean' },
            } } },
        } } },
        useDatatables: { type: 'array', maxItems: 5, description: 'Ids from the Datatables block of the EXISTING tables the plan will use.', items: { type: 'string' } },
    } },
} };

const QUESTIONS_TOOL = { type: 'function', function: {
    name: 'builder_ask_questions', description: `Ask ALL open questions for this plan in ONE call (at most ${MAX_QUESTIONS}, usually 2-4), each with suggested answers. You get one question round per plan. Put the recommended answer first and do not write '(recommended)' in it: the card marks it. Ends the turn and waits for the user. The chat shows the questions as a card, so do NOT repeat them in your message: say at most one short sentence before this call. Each prompt is one short sentence, each option a few words, no lists inside them. `
        + 'To let the user choose a table, pass datatableIds (ids from the Datatables block) and createLabel instead of options; the card lists those tables plus your create option.',
    parameters: { type: 'object', additionalProperties: false, required: ['questions'], properties: {
        questions: { type: 'array', maxItems: MAX_QUESTIONS, items: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
            prompt: { type: 'string' }, options: { type: 'array', minItems: 2, maxItems: MAX_OPTIONS, items: { type: 'string' } },
            header: { type: 'string', description: 'A label of at most three words for this question, shown above it in the card.' },
            datatableIds: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
            createLabel: { type: 'string', maxLength: 60 },
        } } },
    } },
} };

const DEFAULT_CREATE_LABEL = 'Create a new table';

// A question that lets the user pick a table: the options are the tables'
// names plus the model's "create a new table" option. `choice` stays on the
// server (it is how the answer is read back, datatableApproval.resolveTableChoice)
// and never reaches the client. Null = the question is unusable.
function tableQuestion(q, datatables) {
    const rows = [];
    for (const id of q.datatableIds) {
        if (typeof id !== 'string') return null;
        const hit = Array.isArray(datatables) ? lookupTable(id, datatables).hits : [];
        if (hit.length !== 1 || hit[0].pending || rows.some((r) => r.id === hit[0].id)) continue;
        rows.push(hit[0]);
    }
    const names = rows.map((r) => String(r.name || r.key || r.id).trim());
    const labelOf = (r, i) => (names.filter((n) => n.toLowerCase() === names[i].toLowerCase()).length > 1 ? `${names[i]} (${r.key})` : names[i]);
    const options = rows.map((r, i) => ({ label: labelOf(r, i).slice(0, 300), datatableId: r.id }));
    const createLabel = (typeof q.createLabel === 'string' && q.createLabel.trim() ? q.createLabel.trim() : DEFAULT_CREATE_LABEL).slice(0, 60);
    options.push({ label: createLabel, create: true });
    if (options.length < 2 || options.length > 4) return null;
    return {
        id: randomUUID(), prompt: q.prompt.slice(0, 1000), options: options.map((o) => o.label),
        choice: { kind: 'datatable', access: rows.every((r) => r.canWrite) ? 'write' : 'read', options },
    };
}

// A model marks its own favourite ("Finance (recommended)"); the card does
// that from the order, so the marker would show twice.
const RECOMMENDED_SUFFIX = /\s*\((?:recommended|suggested|aanbevolen|voorgesteld)\)\s*$/i;

function cleanOption(option) {
    return stripListMarker(String(option).replace(RECOMMENDED_SUFFIX, '')).slice(0, 300);
}

function withHeader(question, q) {
    const header = typeof q.header === 'string' ? q.header.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return header ? { ...question, header } : question;
}

/**
 * The questions of one builder_ask_questions call, as the card gets them.
 * Tolerant on purpose: a call with one bad question, a seventh question or a
 * fifth answer used to be rejected as a whole, which cost a round and, with
 * one question round per plan, the whole round. Unusable questions are dropped,
 * the rest is cut to the limits. Returns { questions, dropped } (dropped = how
 * many valid questions were cut past MAX_QUESTIONS), or null when no question
 * is usable. A table question's fields (datatableIds, createLabel, and the
 * server-only `choice` it yields) pass through tableQuestion untouched.
 */
function writeQuestions(args, { datatables = null } = {}) {
    if (!Array.isArray(args?.questions)) return null;
    const seen = new Set();
    const valid = [];
    for (const q of args.questions) {
        if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) continue;
        const prompt = stripListMarker(q.prompt).slice(0, 1000);
        const key = prompt.toLowerCase();
        if (seen.has(key)) continue;
        if (Array.isArray(q.datatableIds) && q.datatableIds.length) {
            const tq = tableQuestion({ ...q, prompt }, datatables);
            if (!tq) continue;
            seen.add(key);
            valid.push(withHeader(tq, q));
            continue;
        }
        const options = (Array.isArray(q.options) ? q.options : []).filter(o => typeof o === 'string').map(cleanOption).filter(Boolean).slice(0, MAX_OPTIONS);
        if (options.length < 2) continue;
        seen.add(key);
        valid.push(withHeader({ id: randomUUID(), prompt, options }, q));
    }
    if (!valid.length) return null;
    return { questions: valid.slice(0, MAX_QUESTIONS), dropped: Math.max(0, valid.length - MAX_QUESTIONS) };
}

// The plan view numbers the steps (01, 02, ...) and draws its own bullet, so a
// "1." or "- " the model wrote in front of a line shows up twice. Only a marker
// followed by a space goes: "3 retries on failure" and "1.5 seconds" are text,
// "**Bold** first" starts with a star but not a bullet.
const LIST_MARKER = /^\s*(?:(?:\d{1,3}[.)]|[-*\u2022])\s+)+/;
function stripListMarker(line) {
    const stripped = String(line).replace(LIST_MARKER, '').trim();
    return stripped || String(line).trim();
}

// The tables a plan creates: each goes through the same column reading and
// engine rules as a staged table, and an entry that would not survive them is
// dropped rather than approved and then failing at the build.
function planTables(raw) {
    const { normalizeFields } = require('../../../core/dataEngine/dataModel/datatableFields');
    const out = [];
    for (const t of (Array.isArray(raw) ? raw : []).slice(0, 5)) {
        const name = typeof t?.name === 'string' ? t.name.trim().slice(0, 120) : '';
        if (!name || out.some((x) => normaliseKey(x.name) === normaliseKey(name))) continue;
        const norm = normalizeFields(normaliseFieldArgs(t.fields || t.columns, []).map((f) => ({ ...f })), []);
        if (!norm || !norm.ok || !norm.fields.length) continue;
        out.push({
            name,
            ...(typeof t.description === 'string' && t.description.trim() ? { description: t.description.trim().slice(0, 500) } : {}),
            fields: norm.fields.map(({ key, name: fname, type, options, required }) => ({ key, name: fname, type, ...(options ? { options } : {}), ...(required ? { required: true } : {}) })),
        });
    }
    return out;
}

// The existing tables a plan names, resolved against the catalog; unknown and
// pending entries are dropped.
function planUsedTables(raw, datatables) {
    const out = [];
    for (const term of (Array.isArray(raw) ? raw : []).slice(0, 5)) {
        if (typeof term !== 'string' || !Array.isArray(datatables)) continue;
        const hits = lookupTable(term, datatables).hits;
        if (hits.length !== 1 || hits[0].pending || out.some((t) => t.id === hits[0].id)) continue;
        out.push({ id: hits[0].id, key: hits[0].key, name: hits[0].name });
    }
    return out;
}

function writePlan(args, previous = null, { datatables = null } = {}) {
    if (!args || typeof args.title !== 'string' || typeof args.goal !== 'string'
        || !Array.isArray(args.steps) || !args.steps.length || args.steps.some(s => typeof s !== 'string')) return null;
    const lines = key => (Array.isArray(args[key]) ? args[key] : []).filter(s => typeof s === 'string').slice(0, 40).map(s => stripListMarker(s).slice(0, 2000));
    const tables = planTables(args.datatables);
    const used = planUsedTables(args.useDatatables, datatables);
    return { id: randomUUID(), version: (previous?.version || 0) + 1, title: args.title.slice(0, 200), goal: args.goal.slice(0, 2000),
        assumptions: lines('assumptions'), steps: lines('steps'), prerequisites: lines('prerequisites'), tests: lines('tests'),
        ...(tables.length ? { datatables: tables } : {}), ...(used.length ? { useDatatables: used } : {}), status: 'review' };
}

/** The table a plan lists under this name (null when it does not list one). */
function planDatatableEntry(plan, name) {
    const want = normaliseKey(name);
    if (!want || !Array.isArray(plan?.datatables)) return null;
    return plan.datatables.find((t) => t && normaliseKey(t.name) === want) || null;
}

function changedSteps(before = {}, after = {}, pending = []) {
    const nodes = graph => [graph?.trigger, ...(graph?.triggers || []), ...(graph?.steps || [])].filter(Boolean);
    const old = nodes(before), next = nodes(after);
    const changes = next.filter(n => JSON.stringify(n) !== JSON.stringify(old.find(o => o.id === n.id)))
        .map(n => `${old.some(o => o.id === n.id) ? 'Update' : 'Add'} ${n.label || n.type || n.kind || n.id}`);
    for (const key of new Set([...Object.keys(before?.layers || {}), ...Object.keys(after?.layers || {})])) changes.push(...changedSteps(before?.layers?.[key], after?.layers?.[key]));
    // A table the proposal creates on Apply is a change the user decides on.
    for (const e of Array.isArray(pending) ? pending : []) if (e && e.name) changes.push(`Create table "${e.name}"`);
    return changes;
}

// A direct build that changes this many steps or more waits for the user's
// Apply instead of landing in the live draft ("Ask before applying large
// changes"). A draft without steps is exempt: building a new flow from
// scratch always changes more than a handful of steps (BFSF-486).
const LARGE_CHANGE_STEPS = 4;

function isBlankDraft(def) {
    return !(Array.isArray(def?.steps) && def.steps.length) && !Object.keys(def?.layers || {}).length;
}

// The proposal saved with the session is still pending while the live
// definition is the one it was staged against. Once anything else changed the
// live draft, Apply would refuse it (BuilderShell: stale_proposal), so it is
// not shown to the agent as pending either.
function pendingProposal(saved, liveDef) {
    if (!saved || typeof saved !== 'object' || !saved.id || !saved.definition) return null;
    return isDeepStrictEqual(saved.baseDefinition ?? null, liveDef ?? null) ? saved : null;
}

// One staged table as a line the agent can act on: the id to bind to, the key,
// the name and the columns.
const stagedTableLine = (e) => `${e.ref} · key ${e.key} · "${e.name}" · columns: ${(e.fields || []).map((f) => `${f.key} ${f.type}`).join(', ')}`;

const oneLineText = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * What the model is told about the question card it showed on its last turn.
 * Without it the next turn started blind: the answers were just a user message,
 * the tool was still offered, and the model asked again (the owner's loop).
 * `prior` is the questions as saved in the snapshot; `answeredText` the user's
 * message. Answered = the message is the card's "Q:/A:" text for at least one of
 * them. Typed instead = anything else: the user ignored the card, so the model
 * takes its own suggestion for what the message does not settle and says so.
 * Returns '' when no questions are open.
 */
function questionStatusNote({ prior = null, answeredText = '', mode = 'plan', approvedPlan = null } = {}) {
    const asked = Array.isArray(prior) ? prior.filter(q => q && typeof q.prompt === 'string') : [];
    if (!asked.length) return '';
    const known = new Set(asked.map(q => oneLineText(q.prompt)));
    const parsed = parseAnswersText(answeredText);
    const matched = parsed ? parsed.filter(p => known.has(oneLineText(p.prompt))).length : 0;
    if (matched > 0) {
        const head = `\nThe user answered the ${matched} question${matched === 1 ? '' : 's'} you asked (Q/A in their message). Do not ask them again. `;
        if (approvedPlan) return `${head}Continue the approved plan.`;
        if (mode === 'plan') return `${head}Call builder_write_plan now; put anything still open under assumptions.`;
        return head.trimEnd();
    }
    const list = asked.map((q, i) => `${i + 1}) ${q.prompt}${Array.isArray(q.options) && q.options.length ? ` (suggested: ${q.options[0]})` : ''}`).join(' ');
    return `\nYour last turn asked: ${list}. The user wrote a message instead of using the card. Use it; for every question it does not settle, take the suggested answer and list it as an assumption. Do not ask these again.`;
}

// What the agent is told at the start of a turn about its staged work: what
// the user did with the last proposal (sessionSnapshot.js records it), and
// whether a proposal still waits for Apply. Only the user applies a proposal;
// the agent is told so, because a "yes" in the chat applies nothing.
// `choice` is what the user answered on a table question card (see
// datatableApproval.resolveTableChoice); `liveDef` decides whether the flow
// that used the tables created on Apply was saved.
function reviewStatusNote({ outcome = null, pending = null, isolated = true, liveDef = null, choice = null, plan = null, planCurrent = true } = {}) {
    const lines = [];
    if (outcome?.kind === 'proposal' && outcome.status === 'applied') {
        lines.push('REVIEW STATUS: the user APPLIED your last proposal. Its changes are live; the draft above is the result.');
        const made = Array.isArray(outcome.datatables) ? outcome.datatables.filter((t) => t && t.id) : [];
        if (made.length) {
            lines.push(`The ${made.length > 1 ? 'tables' : 'table'} ${made.map((t) => `"${t.name}" (id ${t.id}, key ${t.key})`).join(', ')} ${made.length > 1 ? 'were' : 'was'} created on Apply.`);
            const live = liveDef ? boundDatatableIds(liveDef) : new Set();
            if (!made.every((t) => live.has(t.id))) lines.push('The flow that used them was not saved; rebuild those steps on these ids.');
        }
    }
    if (outcome?.kind === 'proposal' && outcome.status === 'discarded') lines.push('REVIEW STATUS: the user DISCARDED your last proposal. None of its changes were applied; the draft above is the live version.');
    if (outcome?.kind === 'plan' && outcome.status === 'rejected') lines.push('REVIEW STATUS: the user rejected your last plan.');
    // A plan that waits is built by the button and by nothing else: a typed
    // "yes" reads as approval to a model, and then it starts building in a turn
    // that has no approval behind it (or says it cannot, and loops).
    if (plan?.status === 'review' && planCurrent) {
        lines.push(`PLAN v${plan.version || 1} WAITS FOR APPROVAL. Only the user's Build this plan button builds it; a "yes" typed in the chat builds nothing. If the user approves in the chat, answer in one sentence asking them to press Build this plan. If they ask for a change, call builder_write_plan with the revision.`);
    }
    for (const t of choice?.tables || []) lines.push(`The user chose the existing table "${t.name}" (${t.id}, key ${t.key}). Bind the step to it.`);
    for (const prompt of choice?.createFor || []) lines.push(`The user wants a NEW table for: ${prompt}. Create it with builder_create_datatable.`);
    if (pending) {
        const changes = changedSteps(pending.baseDefinition, pending.definition, pending.pendingDatatables);
        const list = changes.length ? changes.join('; ') : 'name or description only';
        lines.push(isolated
            ? `STAGED, NOT APPLIED: a proposal waits for the user (${list}). The draft above already includes these staged changes. Build on it; do not stage them again.`
            : `STAGED, NOT APPLIED: a proposal waits for the user (${list}). The draft above is the LIVE version without it. Changing the live draft now makes that proposal out of date.`);
        if (Array.isArray(pending.pendingDatatables) && pending.pendingDatatables.length) {
            lines.push(`STAGED TABLES (not created yet; created when the user presses Apply; use these ids): ${pending.pendingDatatables.map(stagedTableLine).join(' | ')}.`);
        }
        lines.push('Only the user applies a proposal, with the Apply button on the proposal card. A "yes" or "approve" typed in the chat applies nothing: when the user approves in the chat, ask them to press Apply. Call these changes staged until a later turn reports them applied.');
    }
    return lines.length ? `\n${lines.join('\n')}` : '';
}

// Every change tool result in a work mode says where its change went, so the
// agent never has to guess whether a step is live: `staged` (in the proposal,
// waiting for Apply), `applied` (in the live draft), `rejected` (nothing
// changed) or `partial` (a batch that stopped part way).
function withChangeStatus(result, { isolated, buffered = false }) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const where = isolated ? 'staged' : 'applied';
    if (result.error) {
        const partial = Array.isArray(result.added) && result.added.length > 0;
        result.changeStatus = partial ? 'partial' : 'rejected';
        result._status = partial ? `The steps in "added" are ${where}; the rest was refused.` : 'Nothing changed: this call was refused.';
    } else if (result.staged) {
        // A new table: it never lands in the live draft on its own, not even in
        // a buffered build; creating it is the user's Apply.
        result.changeStatus = 'staged';
        result._status = buffered ? 'Staged: a new table always waits for the user\'s Apply.' : 'Staged, not applied. The user applies it with the Apply button.';
    } else {
        result.changeStatus = where;
        result._status = !isolated ? 'Applied to the live draft.'
            : buffered ? `Staged, not applied yet. At the end of this turn it is applied if fewer than ${LARGE_CHANGE_STEPS} steps changed; otherwise it waits for the user's Apply.`
                : 'Staged, not applied. The user applies it with the Apply button.';
    }
    return result;
}

// A read of the draft during an isolated turn that holds staged changes says
// so, so the agent never takes the staged version for the live one.
function markStagedView(result, staged) {
    if (staged && result && typeof result === 'object' && !Array.isArray(result) && !result.error) {
        result.draftView = 'staged';
        result._draftView = 'This view includes staged changes that are not applied yet.';
    }
    return result;
}

module.exports = { MODES, MAX_QUESTIONS, MAX_OPTIONS, PLAN_TOOL, QUESTIONS_TOOL, LARGE_CHANGE_STEPS, TABLE_CONSENT_RULE, writeQuestions, planDatatableEntry, stripListMarker, toolAllowed, previewRefusal, planMentionsRemoval, planCoversRemoval, resolveRemovalTarget, modeInstruction, writePlan, changedSteps,
    isBlankDraft, pendingProposal, reviewStatusNote, questionStatusNote, withChangeStatus, markStagedView };
