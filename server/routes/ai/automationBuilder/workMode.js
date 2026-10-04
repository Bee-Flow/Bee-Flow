const { randomUUID } = require('node:crypto');
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

module.exports = { MODES, PLAN_TOOL, QUESTIONS_TOOL, writeQuestions, toolAllowed, modeInstruction, writePlan, changedSteps };
