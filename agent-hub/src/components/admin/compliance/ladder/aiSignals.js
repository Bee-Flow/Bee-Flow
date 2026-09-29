/**
 * aiSignals — the CLIENT fallback for the AI Act signals (Compliance Center
 * redesign, Sep 2026). Used by ComplianceBlock / AiActLadderModal when
 * `GET /api/compliance/ai-act/assessments/:kind/:id/signals` is absent (404,
 * the backend for it not yet deployed) so the block can still say "1 AI step
 * · customer-facing via form" from the definition it already holds.
 *
 * It mirrors `server/compliance/lib/automationGraph.js` (same step types,
 * same nesting: loop bodies, parallel branches, layers) and produces the
 * server's snake_case `signals` shape so the rest of the ladder never knows
 * which side computed them. What the client cannot know it leaves `null`
 * (`disclosure_present`, `marking_enabled`) — unknown, not false: an unknown
 * signal is never painted as a failure.
 *
 * `summarize` is NOT an AI step (CONTRACTS.md): it is an aggregate op over a
 * collection. `automationGraph.isAiStep` and this list must agree.
 */

export const AI_STEP_TYPES = Object.freeze(['ai_step', 'data_extraction', 'ai_tool']);
const _AI = new Set(AI_STEP_TYPES);

/** Steps that stand between a routine and a person outside the org. */
export const CUSTOMER_FACING_STEP_TYPES = Object.freeze(['form_page']);

/** Steps that write model output into a file (Art. 50(2) marking subjects). */
export const GENERATING_STEP_TYPES = Object.freeze(['generate_document']);

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

export function isAiStep(step) {
    return isObject(step) && _AI.has(step.type);
}

/**
 * Every step of a definition in walk order — root graph, then each layer —
 * descending into loop bodies (`step.body[]`) and parallel branches
 * (`step.branches[][]`), parents before their children. condition/switch
 * steps have no nested arms in this grammar (their branches are edges).
 */
export function listSteps(definition) {
    const out = [];
    if (!isObject(definition)) return out;
    _walkGraph(definition.steps, null, out);
    if (isObject(definition.layers)) {
        for (const [key, layer] of Object.entries(definition.layers)) {
            if (isObject(layer)) _walkGraph(layer.steps, key, out);
        }
    }
    return out;
}

function _walkGraph(steps, layer, out, parentId = null, seen = new Set()) {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
        if (!isObject(step) || seen.has(step)) continue;
        seen.add(step);
        out.push({ step, parentId, layer });
        if (step.type === 'loop' && Array.isArray(step.body)) {
            _walkGraph(step.body, layer, out, step.id ?? null, seen);
        } else if (step.type === 'parallel' && Array.isArray(step.branches)) {
            for (const branch of step.branches) {
                _walkGraph(Array.isArray(branch) ? branch : branch?.steps, layer, out, step.id ?? null, seen);
            }
        }
    }
}

/** A step's human label — the builder's `label`/`name`/`title`, else its id, else its type. */
export function stepLabel(step) {
    if (!isObject(step)) return '';
    for (const k of ['label', 'name', 'title']) {
        if (typeof step[k] === 'string' && step[k].trim()) return step[k].trim();
    }
    return String(step.id ?? step.type ?? '');
}

function isFormTrigger(trigger) {
    return isObject(trigger) && (trigger.kind === 'form' || trigger.type === 'form');
}

/** The definition object of an automation record (`definition` may be a JSON string on older rows). */
export function definitionOf(automation) {
    if (!isObject(automation)) return null;
    const d = automation.definition ?? automation.graph ?? null;
    if (typeof d === 'string') {
        try { return JSON.parse(d); } catch { return null; }
    }
    return isObject(d) ? d : null;
}

/**
 * Signals for an automation (routine) from its record — `signalsForAutomation`
 * on the server, minus what needs the database.
 * @returns {{ contains_ai, customer_facing, generates_content, disclosure_present: null,
 *             marking_enabled: null, annex_iii_hint: null, steps: { ai: [{id,label}], generating: [{id,label}] },
 *             step_count: number, surface: 'form'|null, source: 'client' }}
 */
export function signalsForAutomation(automation) {
    const def = definitionOf(automation) || {};
    const items = listSteps(def);
    const ai = items.filter(x => isAiStep(x.step)).map(x => ({ id: x.step.id ?? null, label: stepLabel(x.step) }));
    const generating = items
        .filter(x => GENERATING_STEP_TYPES.includes(x.step.type))
        .map(x => ({ id: x.step.id ?? null, label: stepLabel(x.step) }));

    const triggers = Array.isArray(def.triggers) ? def.triggers : [];
    const formTrigger = isFormTrigger(def.trigger) || triggers.some(isFormTrigger);
    const formStep = items.some(x => CUSTOMER_FACING_STEP_TYPES.includes(x.step.type));
    const customerFacing = formTrigger || formStep;

    return {
        contains_ai: ai.length > 0,
        customer_facing: customerFacing,
        generates_content: generating.length > 0,
        disclosure_present: null,
        marking_enabled: null,
        annex_iii_hint: null,
        steps: { ai, generating },
        step_count: items.length,
        surface: customerFacing ? 'form' : null,
        source: 'client',
    };
}

/**
 * Signals for an agent — `signalsForAgent` on the server: an agent IS a
 * model, so it always contains AI and always generates content; it faces
 * customers when published.
 */
export function signalsForAgent(agent) {
    const a = isObject(agent) ? agent : {};
    const published = a.is_published === true || a.isPublished === true || a.status === 'published';
    return {
        contains_ai: true,
        customer_facing: published,
        generates_content: true,
        disclosure_present: null,
        marking_enabled: null,
        annex_iii_hint: null,
        steps: { ai: [], generating: [] },
        step_count: null,
        surface: published ? 'published_agent' : null,
        source: 'client',
    };
}

/** Dispatch on `kind` ('automation' | 'agent'); unknown kind → null (renders nothing). */
export function fallbackSignals(kind, target) {
    if (kind === 'automation') return signalsForAutomation(target);
    if (kind === 'agent') return signalsForAgent(target);
    return null;
}

export default fallbackSignals;
