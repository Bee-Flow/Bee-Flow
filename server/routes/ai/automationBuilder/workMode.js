const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { MUTATING_TOOLS } = require('../../../automation/builderTools');

// These tools only inspect the draft or a schema. Unknown tools fail closed.
const READ_TOOLS = new Set(['builder_inspect_tool', 'builder_summarise', 'builder_set_plan',
    'builder_ask_questions', 'builder_write_plan', 'builder_inspect_step', 'builder_inspect_mapping', 'builder_inspect_run', 'webpages_list', 'webpage_db_schema', 'webpage_db_query', 'webpage_file_read']);
const PREVIEW_BLOCKED = new Set(['builder_finalize', 'builder_request_dry_run', 'builder_create_datatable',
    'builder_generate_layer', 'builder_generate_layers']);
const MODES = ['discuss', 'approve', 'plan', 'build'];

function toolAllowed(name, mode) {
    if (mode === 'build') return name !== 'builder_remove_step';
    if (READ_TOOLS.has(name)) return true;
    return mode === 'approve' && MUTATING_TOOLS.has(name) && !PREVIEW_BLOCKED.has(name);
}

function modeInstruction(mode, plan = null) {
    const common = '\nASSISTANT WORK MODE (overrides build-first instructions and examples above): ';
    if (mode === 'discuss') return common + 'DISCUSS ONLY. Explain and advise. Read the draft and schemas. Never change anything. Ask only questions you cannot infer from the available context.';
    if (mode === 'plan') return common + 'PLAN FIRST. Explore the draft and schemas without changing anything. Use builder_ask_questions to bundle essential questions with suggested answers. Then call builder_write_plan with a readable title, goal, assumptions, numbered steps, prerequisites and tests. Wait for explicit plan approval. A todo checklist is not approval. Never build in this turn.';
    if (mode === 'approve') return common + 'PROPOSE CHANGES. Draft tools change an isolated preview only. Describe exactly what changed, including field mappings (old → new), and why. Do not claim changes are applied. The human applies or discards the proposal. Do not run external actions or create tables during a preview.';
    return common + 'BUILD DIRECTLY. Make changes visible. Removing a step requires a separate human-approved proposal. Never activate or publish. '
        + (plan ? `Follow this approved plan; report any deviation and ask before changing its scope: ${JSON.stringify(plan)}` : '');
}

const PLAN_TOOL = { type: 'function', function: {
    name: 'builder_write_plan', description: 'Write or revise the plan for human review. Does not modify the automation. Build only after the human approves this exact revision.',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'goal', 'steps'], properties: {
        title: { type: 'string' }, goal: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } },
        prerequisites: { type: 'array', items: { type: 'string' } },
        tests: { type: 'array', items: { type: 'string' } },
    } },
} };

const QUESTIONS_TOOL = { type: 'function', function: {
    name: 'builder_ask_questions', description: 'Ask up to three essential questions together, each with suggested answers. Put the recommended answer first. Ends the turn and waits for the user.',
    parameters: { type: 'object', additionalProperties: false, required: ['questions'], properties: {
        questions: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['prompt', 'options'], properties: {
            prompt: { type: 'string' }, options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' } },
        } } },
    } },
} };
function writeQuestions(args) {
    if (!Array.isArray(args?.questions) || !args.questions.length || args.questions.length > 3) return null;
    if (args.questions.some(q => typeof q.prompt !== 'string' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4 || q.options.some(o => typeof o !== 'string'))) return null;
    return args.questions.map(q => ({ id: randomUUID(), prompt: q.prompt.slice(0, 1000), options: q.options.map(o => o.slice(0, 300)) }));
}

function writePlan(args, previous = null) {
    if (!args || typeof args.title !== 'string' || typeof args.goal !== 'string'
        || !Array.isArray(args.steps) || !args.steps.length || args.steps.some(s => typeof s !== 'string')) return null;
    const lines = key => (Array.isArray(args[key]) ? args[key] : []).filter(s => typeof s === 'string').slice(0, 40).map(s => s.slice(0, 2000));
    return { id: randomUUID(), version: (previous?.version || 0) + 1, title: args.title.slice(0, 200), goal: args.goal.slice(0, 2000),
        assumptions: lines('assumptions'), steps: lines('steps'), prerequisites: lines('prerequisites'), tests: lines('tests'), status: 'review' };
}

function changedSteps(before = {}, after = {}) {
    const nodes = graph => [graph?.trigger, ...(graph?.triggers || []), ...(graph?.steps || [])].filter(Boolean);
    const old = nodes(before), next = nodes(after);
    const changes = next.filter(n => JSON.stringify(n) !== JSON.stringify(old.find(o => o.id === n.id)))
        .map(n => `${old.some(o => o.id === n.id) ? 'Update' : 'Add'} ${n.label || n.type || n.kind || n.id}`);
    for (const key of new Set([...Object.keys(before?.layers || {}), ...Object.keys(after?.layers || {})])) changes.push(...changedSteps(before?.layers?.[key], after?.layers?.[key]));
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

// What the agent is told at the start of a turn about its staged work: what
// the user did with the last proposal (sessionSnapshot.js records it), and
// whether a proposal still waits for Apply. Only the user applies a proposal;
// the agent is told so, because a "yes" in the chat applies nothing.
function reviewStatusNote({ outcome = null, pending = null, isolated = true } = {}) {
    const lines = [];
    if (outcome?.kind === 'proposal' && outcome.status === 'applied') lines.push('REVIEW STATUS: the user APPLIED your last proposal. Its changes are live; the draft above is the result.');
    if (outcome?.kind === 'proposal' && outcome.status === 'discarded') lines.push('REVIEW STATUS: the user DISCARDED your last proposal. None of its changes were applied; the draft above is the live version.');
    if (outcome?.kind === 'plan' && outcome.status === 'rejected') lines.push('REVIEW STATUS: the user rejected your last plan.');
    if (pending) {
        const changes = changedSteps(pending.baseDefinition, pending.definition);
        const list = changes.length ? changes.join('; ') : 'name or description only';
        lines.push(isolated
            ? `STAGED, NOT APPLIED: a proposal waits for the user (${list}). The draft above already includes these staged changes. Build on it; do not stage them again.`
            : `STAGED, NOT APPLIED: a proposal waits for the user (${list}). The draft above is the LIVE version without it. Changing the live draft now makes that proposal out of date.`);
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

module.exports = { MODES, PLAN_TOOL, QUESTIONS_TOOL, LARGE_CHANGE_STEPS, writeQuestions, toolAllowed, modeInstruction, writePlan, changedSteps,
    isBlankDraft, pendingProposal, reviewStatusNote, withChangeStatus, markStagedView };
