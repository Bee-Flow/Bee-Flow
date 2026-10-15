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

/** A plain JSON object. */
type Obj = Record<string, unknown>;

/** One step of an automation definition, as far as this module reads it. */
export type StepObj = Obj;

/** A step reference in the signals: its id and label. */
export interface StepRef {
    id: unknown;
    label: string;
}

/** One step with where it sits in the walk. */
export interface WalkItem {
    step: StepObj;
    parentId: unknown;
    layer: string | null;
}

/** The snake_case signals the ladder reads, computed here or on the server. */
export interface AiSignals {
    contains_ai: boolean;
    customer_facing: boolean;
    generates_content: boolean;
    disclosure_present: boolean | null;
    marking_enabled: boolean | null;
    annex_iii_hint: string | null;
    steps: { ai: StepRef[]; generating: StepRef[] };
    step_count: number | null;
    surface: string | null;
    source: 'client';
}

export const AI_STEP_TYPES: readonly string[] = Object.freeze(['ai_step', 'data_extraction', 'ai_tool']);
const _AI = new Set<string>(AI_STEP_TYPES);

/** Steps that stand between an automation and a person outside the org. */
export const CUSTOMER_FACING_STEP_TYPES: readonly string[] = Object.freeze(['form_page']);

/** Steps that write model output into a file (Art. 50(2) marking subjects). */
export const GENERATING_STEP_TYPES: readonly string[] = Object.freeze(['generate_document']);

function isObject(v: unknown): v is Obj {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A step's `type`, when it is a string. */
function typeOf(step: StepObj): string | undefined {
    return typeof step.type === 'string' ? step.type : undefined;
}

export function isAiStep(step: unknown): boolean {
    return isObject(step) && typeof step.type === 'string' && _AI.has(step.type);
}

/**
 * Every step of a definition in walk order — root graph, then each layer —
 * descending into loop bodies (`step.body[]`) and parallel branches
 * (`step.branches[][]`), parents before their children. condition/switch
 * steps have no nested arms in this grammar (their branches are edges).
 */
export function listSteps(definition: unknown): WalkItem[] {
    const out: WalkItem[] = [];
    if (!isObject(definition)) return out;
    _walkGraph(definition.steps, null, out);
    if (isObject(definition.layers)) {
        for (const [key, layer] of Object.entries(definition.layers)) {
            if (isObject(layer)) _walkGraph(layer.steps, key, out);
        }
    }
    return out;
}

function _walkGraph(steps: unknown, layer: string | null, out: WalkItem[], parentId: unknown = null, seen: Set<unknown> = new Set()): void {
    if (!Array.isArray(steps)) return;
    for (const step of steps as unknown[]) {
        if (!isObject(step) || seen.has(step)) continue;
        seen.add(step);
        out.push({ step, parentId, layer });
        if (step.type === 'loop' && Array.isArray(step.body)) {
            _walkGraph(step.body, layer, out, step.id ?? null, seen);
        } else if (step.type === 'parallel' && Array.isArray(step.branches)) {
            for (const branch of step.branches as unknown[]) {
                _walkGraph(Array.isArray(branch) ? branch : (isObject(branch) ? branch.steps : undefined), layer, out, step.id ?? null, seen);
            }
        }
    }
}

/** A step's human label — the builder's `label`/`name`/`title`, else its id, else its type. */
export function stepLabel(step: unknown): string {
    if (!isObject(step)) return '';
    for (const k of ['label', 'name', 'title']) {
        const v = step[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return String(step.id ?? step.type ?? '');
}

function isFormTrigger(trigger: unknown): boolean {
    return isObject(trigger) && (trigger.kind === 'form' || trigger.type === 'form');
}

/** The definition object of an automation record (`definition` may be a JSON string on older rows). */
export function definitionOf(automation: unknown): unknown {
    if (!isObject(automation)) return null;
    const d = automation.definition ?? automation.graph ?? null;
    if (typeof d === 'string') {
        try { return JSON.parse(d); } catch { return null; }
    }
    return isObject(d) ? d : null;
}

/**
 * Signals for an automation (automation) from its record — `signalsForAutomation`
 * on the server, minus what needs the database.
 */
export function signalsForAutomation(automation: unknown): AiSignals {
    const def = (definitionOf(automation) || {}) as Obj;
    const items = listSteps(def);
    const ai = items.filter(x => isAiStep(x.step)).map(x => ({ id: x.step.id ?? null, label: stepLabel(x.step) }));
    const generating = items
        .filter(x => { const ty = typeOf(x.step); return ty !== undefined && GENERATING_STEP_TYPES.includes(ty); })
        .map(x => ({ id: x.step.id ?? null, label: stepLabel(x.step) }));

    const triggers: unknown[] = Array.isArray(def.triggers) ? def.triggers : [];
    const formTrigger = isFormTrigger(def.trigger) || triggers.some(isFormTrigger);
    const formStep = items.some(x => { const ty = typeOf(x.step); return ty !== undefined && CUSTOMER_FACING_STEP_TYPES.includes(ty); });
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
export function signalsForAgent(agent: unknown): AiSignals {
    const a: Obj = isObject(agent) ? agent : {};
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
export function fallbackSignals(kind: string, target: unknown): AiSignals | null {
    if (kind === 'automation') return signalsForAutomation(target);
    if (kind === 'agent') return signalsForAgent(target);
    return null;
}

export default fallbackSignals;
