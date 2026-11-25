/**
 * What a plan may do, derived from the plan and nothing else, and the fingerprint that says which plan was approved.
 *
 * PERMISSIONS. A Cowork item used to run with whatever its owner's account could reach. A plan runs with what its
 * steps name: each connected app it touches, as reads, writes or sends, with the tool names behind it. That list is
 * what a person approves, and what a run is held to.
 *
 * FINGERPRINT. One hash of the plan itself. The approved fingerprint is stored with the item; a run compares it with
 * the plan of that moment, so nothing runs that is not, step for step, what was approved. Layout (where a step sits
 * on a canvas, its colour) is left out: moving a box is not a change to the plan.
 *
 * WIDENS. A changed plan needs its owner's approval again only when it may do MORE than the approved one: a new app,
 * a stronger effect on a known app, a new tool, a first send to other people, a first model call, a first read of
 * outside text. A plan that does less, or the same in another order, does not.
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { Definition, DefStep, Effect, Grant, PlanPermissions, ToolLookups } from './planTypes.mts';
import { isAnnotation, kindOfStepType } from './coworkStepList.mts';
import { outsideTextOf, triggerBringsOutsideText } from './outsideText.mts';
import { stepsOf, aiToolsOf } from './planWalk.mts';

const nodeRequire = createRequire(import.meta.url);
const { stableStringify } = nodeRequire('../../../utils/stableJson.js') as {
    stableStringify: (value: unknown, opts?: { undefined?: 'null' | 'drop' | 'raw' }) => string;
};
const { DATATABLE_WRITE_OPS } = nodeRequire('../../automationModel/constants.js') as { DATATABLE_WRITE_OPS: Set<unknown> };

/** The app a built-in tool with no owner is listed under. */
export const BUILT_IN_APP = 'bee-flow';
/** The organisation's own tables and documents, as apps of a plan. */
export const DATATABLES_APP = 'datatables';
export const DOCUMENTS_APP = 'documents';
/** The knowledge bases an AI step is grounded on. */
export const KNOWLEDGE_APP = 'knowledge-bases';

const RANK: Readonly<Record<Effect, number>> = Object.freeze({ reads: 0, writes: 1, sends: 2 });

/** The (app, effect, tool) triples one step adds. */
function triplesOf(step: DefStep, type: string, lookups: ToolLookups): Array<[string, Effect, string]> {
    const ofTool = (tool: string): [string, Effect, string] => [lookups.appOfTool(tool) ?? BUILT_IN_APP, lookups.effectOfTool(tool), tool];
    if (type === 'integration_action') return typeof step.tool === 'string' && step.tool ? [ofTool(step.tool)] : [];
    if (type === 'ai_step') {
        const bases = Array.isArray(step.knowledgeBaseIds) ? step.knowledgeBaseIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
        return [...aiToolsOf(step).map(ofTool), ...bases.map((id): [string, Effect, string] => [KNOWLEDGE_APP, 'reads', `knowledge_base:${id}`])];
    }
    if (type === 'datatable') {
        const op = typeof step.op === 'string' && step.op ? step.op : 'read';
        return [[DATATABLES_APP, DATATABLE_WRITE_OPS.has(step.op) ? 'writes' : 'reads', `datatable.${op}`]];
    }
    if (['generate_document', 'fill_document', 'presentation', 'write_table'].includes(type)) return [[DOCUMENTS_APP, 'writes', type]];
    return [];
}

/** Everything this plan may do. */
export function permissionsOf(definition: Definition | null | undefined, lookups: ToolLookups): PlanPermissions {
    const byKey = new Map<string, Grant>();
    let ai = false;
    let reachesOwner = false;
    for (const s of stepsOf(definition)) {
        if (isAnnotation(s.type)) continue;
        const kind = kindOfStepType(s.type);
        if (kind === 'ai') ai = true;
        if (kind === 'ask' || kind === 'deliver') reachesOwner = true;
        for (const [app, effect, tool] of triplesOf(s.step, s.type, lookups)) {
            const key = `${app}\n${effect}`;
            const grant = byKey.get(key) ?? { app, effect, tools: [] };
            if (!grant.tools.includes(tool)) grant.tools.push(tool);
            byKey.set(key, grant);
        }
    }
    const grants = [...byKey.values()]
        .map((g) => ({ ...g, tools: [...g.tools].sort() }))
        .sort((a, b) => (a.app === b.app ? RANK[a.effect] - RANK[b.effect] : a.app < b.app ? -1 : 1));
    const sendsToOthers = grants.some((g) => g.effect === 'sends');
    const outside = outsideTextOf(definition, lookups);
    return {
        v: 1,
        grants,
        sends: sendsToOthers ? 'others' : reachesOwner ? 'owner' : 'none',
        ai,
        outsideText: outside.carries.size > 0 || triggerBringsOutsideText(definition),
    };
}

const SENDS_RANK: Readonly<Record<PlanPermissions['sends'], number>> = Object.freeze({ none: 0, owner: 1, others: 2 });

/**
 * What `next` may do that `approved` may not, as sentences; empty when nothing was added. A plan that widens waits
 * for its owner's approval again.
 */
export function widens(next: PlanPermissions, approved: PlanPermissions | null | undefined): string[] {
    if (!approved) return ['This plan has not been approved yet.'];
    const out: string[] = [];
    const had = new Set(approved.grants.flatMap((g) => g.tools.map((t) => `${g.app}\n${g.effect}\n${t}`)));
    for (const g of next.grants) {
        const added = g.tools.filter((t) => !had.has(`${g.app}\n${g.effect}\n${t}`));
        if (added.length > 0) out.push(`${g.app}: ${g.effect} (${added.join(', ')})`);
    }
    if (SENDS_RANK[next.sends] > SENDS_RANK[approved.sends]) {
        out.push(next.sends === 'others' ? 'It can now send to other people.' : 'It can now send to its owner.');
    }
    if (next.ai && !approved.ai) out.push('It now uses AI.');
    if (next.outsideText && !approved.outsideText) out.push('It now reads text written outside the workspace.');
    return out;
}

// ── Fingerprint ─────────────────────────────────────────────────────────

/** Keys that only say how a step, an edge or a graph is drawn (the automation diff's own lists, automation/fieldDiff.js). */
export const LAYOUT_NODE_KEYS: readonly string[] = Object.freeze(['position', 'size', 'width', 'height', 'color', 'icon', 'iconManual', 'labelManual']);
export const LAYOUT_EDGE_KEYS: readonly string[] = Object.freeze(['color']);
export const LAYOUT_GRAPH_KEYS: readonly string[] = Object.freeze(['piiLineColors']);

const CHILD_FIELDS: readonly string[] = ['body', 'branches'];

function without(value: unknown, keys: readonly string[]): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!keys.includes(k)) out[k] = v;
    return out;
}

/** A step without its layout, its children likewise; a canvas note is not part of the plan at all. */
function plainSteps(steps: unknown): unknown[] {
    if (!Array.isArray(steps)) return [];
    const out: unknown[] = [];
    for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        if ((step as DefStep).type === 'note') continue;
        const plain = without(step, LAYOUT_NODE_KEYS) as Record<string, unknown>;
        for (const field of CHILD_FIELDS) {
            const inner = plain[field];
            if (field === 'branches' && Array.isArray(inner)) plain[field] = inner.map((b) => plainSteps(b));
            else if (Array.isArray(inner)) plain[field] = plainSteps(inner);
        }
        out.push(plain);
    }
    return out;
}

/** The plan without anything that is only layout: what the fingerprint is taken of. */
export function plainPlan(definition: Definition | null | undefined): Record<string, unknown> {
    const def = definition && typeof definition === 'object' ? definition : {};
    const graph = without(def, LAYOUT_GRAPH_KEYS) as Record<string, unknown>;
    return {
        ...graph,
        trigger: without(def.trigger, LAYOUT_NODE_KEYS),
        steps: plainSteps(def.steps),
        edges: Array.isArray(def.edges) ? def.edges.map((e) => without(e, LAYOUT_EDGE_KEYS)) : [],
    };
}

/** The fingerprint of a plan: SHA-256 over its plain form, keys in a fixed order. */
export function planFingerprint(definition: Definition | null | undefined): string {
    return createHash('sha256').update(stableStringify(plainPlan(definition), { undefined: 'drop' })).digest('hex');
}
