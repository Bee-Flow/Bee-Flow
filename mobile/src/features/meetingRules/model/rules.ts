/**
 * What a RULE on a meeting note is, read off the automation itself — a port
 * of agent-hub pages/meeting-notes/lib/meetingRules.js, held to it by
 * rules.lockstep.test.ts, which runs both on the same definitions.
 *
 * A rule is an automation with an `app_event` trigger on provider
 * `meeting-notes` (server/automation/triggerSources/declared/meeting-notes.js).
 * Both readings below use ALLOW-lists so the unknown stands out instead of
 * vanishing: `consequencesOf` names three step kinds, knows which kinds change
 * nothing outside the run, and COUNTS everything else; `triggerConditionOf`
 * reads `tags` and `reprocessed`, and any other filter key sets `extra`.
 */

export const RULE_TRIGGER_PROVIDER = 'meeting-notes';
export const RULE_TRIGGER_EVENT = 'meeting.processed';

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const appEventOf = (t: Obj): Obj => (isObject(t.appEvent) ? t.appEvent : {});

/** The meeting-notes triggers: the primary one plus any extra entry point in `triggers[]`. */
export function meetingTriggersOf(definition: unknown): Obj[] {
    const d = isObject(definition) ? definition : {};
    return [d.trigger, ...list(d.triggers)].filter(
        (t): t is Obj => isObject(t) && t.kind === 'app_event' && appEventOf(t).provider === RULE_TRIGGER_PROVIDER,
    );
}

function asTagList(v: unknown): string[] {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
    return raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

const FILTER_KNOWN_KEYS = new Set(['tags', 'reprocessed']);

export interface TriggerCondition {
    /** A UNION over the triggers: the matcher fires on any of them. */
    tags: string[];
    reprocessed: boolean | undefined;
    /** Narrower than the sentence can say. */
    extra: boolean;
    events: string[];
    onlyProcessed: boolean;
}

/** The rule's condition, or null when this is not a meeting-notes rule. */
export function triggerConditionOf(definition: unknown): TriggerCondition | null {
    const triggers = meetingTriggersOf(definition);
    if (!triggers.length) return null;
    const tags: string[] = [];
    const reprocessedSeen = new Set<boolean | undefined>();
    const events = new Set<string>();
    let extra = false;
    for (const trigger of triggers) {
        const appEvent = appEventOf(trigger);
        events.add(typeof appEvent.event === 'string' ? appEvent.event : '');
        const filter = isObject(appEvent.filter) ? appEvent.filter : {};
        for (const tag of asTagList(filter.tags)) if (!tags.includes(tag)) tags.push(tag);
        reprocessedSeen.add(filter.reprocessed === true ? true : filter.reprocessed === false ? false : undefined);
        for (const key of Object.keys(filter)) {
            if (!FILTER_KNOWN_KEYS.has(key) && filter[key] !== undefined) extra = true;
        }
    }
    if (reprocessedSeen.size > 1) extra = true;
    const reprocessed = reprocessedSeen.size === 1 ? [...reprocessedSeen][0] : undefined;
    const onlyProcessed = events.size === 1 && events.has(RULE_TRIGGER_EVENT);
    return { tags, reprocessed, extra, events: [...events], onlyProcessed };
}

const DATATABLE_WRITE_OPS = new Set(['add_row', 'save_row', 'update_rows', 'delete_rows']);
const DATATABLE_READ_OPS = new Set(['find_rows', 'count_rows']);

/** Step kinds that change nothing outside the run (see the web file for each one's reason). */
const NO_OUTWARD_EFFECT = new Set([
    'trigger', 'note',
    'condition', 'switch', 'guard', 'filter', 'limit', 'dedupe', 'aggregate', 'summarize', 'flatten',
    'set', 'datetime', 'parse_json', 'wait',
    'tokenize', 'untokenize',
    'loop', 'parallel', 'call_layer', 'layer_output',
    'ai_step',
]);

/** A code step always has an HTTP bridge; an ai_step only reaches out with tools. */
function reachesOutward(step: Obj): boolean {
    if (step.type === 'code') return true;
    if (step.type !== 'ai_step') return false;
    return Boolean(step.allowTools) || (Array.isArray(step.tools) && step.tools.length > 0);
}

function walkSteps(steps: unknown, visit: (step: Obj) => void): void {
    for (const step of list(steps)) {
        if (!isObject(step)) continue;
        visit(step);
        if (Array.isArray(step.body)) walkSteps(step.body, visit);
        if (Array.isArray(step.branches)) for (const branch of step.branches) walkSteps(branch, visit);
    }
}

export interface Consequences {
    /** False when the definition carried no step list at all. */
    readable: boolean;
    kb: boolean;
    notify: boolean;
    table: boolean;
    /** Steps this reading cannot describe. */
    other: number;
    /** Every step but the trigger, inert ones included. */
    steps: number;
}

export function consequencesOf(definition: unknown): Consequences {
    if (!isObject(definition) || !Array.isArray(definition.steps)) {
        return { readable: false, kb: false, notify: false, table: false, other: 0, steps: 0 };
    }
    const out: Consequences = { readable: true, kb: false, notify: false, table: false, other: 0, steps: 0 };
    const visit = (step: Obj) => {
        const type = typeof step.type === 'string' ? step.type : '';
        if (type !== 'trigger') out.steps += 1;
        if (type === 'knowledge_write') out.kb = true;
        else if (type === 'notification') out.notify = true;
        else if (type === 'datatable') {
            const op = step.op as string;
            if (DATATABLE_WRITE_OPS.has(op)) out.table = true;
            else if (!DATATABLE_READ_OPS.has(op)) out.other += 1;
        } else if (reachesOutward(step) || !NO_OUTWARD_EFFECT.has(type)) out.other += 1;
    };
    walkSteps(definition.steps, visit);
    const layers = isObject(definition.layers) ? Object.values(definition.layers) : [];
    for (const layer of layers) if (isObject(layer)) walkSteps(layer.steps, visit);
    return out;
}

/**
 * May the reader open this rule? GET /api/automation/:id answers 403 unless
 * the reader owns it, so only a POSITIVE match links; no owner or no reader
 * is 'unknown' — no link and no claim about whose rule it is.
 */
export function openability(row: { userId?: string | null; ownerId?: string | null }, currentUserId: string | null) {
    const owner = row.userId ?? row.ownerId ?? null;
    if (!owner || !currentUserId) return 'unknown' as const;
    return owner === currentUserId ? ('ok' as const) : ('foreign' as const);
}

/** One automation's count in `/_runs/facets` (the READER's runs), or null when nobody counted. */
export function runCountOf(facets: unknown, automationId: string): number | null {
    const byId = isObject(facets) ? facets.automationId : null;
    if (!isObject(byId)) return null;
    const n = byId[automationId];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function facetsReadable(facets: unknown): boolean {
    return isObject(facets) && isObject(facets.automationId);
}

/**
 * The trigger node's label in the builder, byte-equal to the web's draft (the
 * lockstep test compares the whole definition). It is stored data the builder
 * shows, not copy this screen renders, so it is not translated here.
 */
const TRIGGER_LABEL = 'Meeting note ready';

/** "+ Rule": the right trigger, an EMPTY filter (every finished note), no steps yet. */
export function newRuleDefinition() {
    return {
        schemaVersion: 1,
        trigger: {
            id: 'trg',
            type: 'trigger',
            kind: 'app_event',
            label: TRIGGER_LABEL,
            appEvent: { provider: RULE_TRIGGER_PROVIDER, event: RULE_TRIGGER_EVENT, filter: {} },
        },
        steps: [],
        edges: [],
        vars: {},
    };
}
