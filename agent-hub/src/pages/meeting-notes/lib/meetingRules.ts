import { segmentForSection } from '../../../components/admin/Studio/studioRoutes';
import type { RuleRow, RunFacets } from '../library/RulesPanel.types';

/**
 * What a RULE on a meeting note is, read from the automation itself (M5, part D). The prose lives in RulesPanel.jsx; here only what is true is stated, so that the card does not have to invent any claim.
 *
 * A rule is an automation with an `app_event` trigger on provider `meeting-notes` — the declaration in server/automation/triggerSources/declared/meeting-notes.js. The list comes from `GET /api/automation?triggerProvider=…` and by contract contains only the reader's own automations (`getAutomationsForUser` is `WHERE user_id = $1`).
 *
 * ── THE UNKNOWN DOES NOT DISAPPEAR ──────────────────────────────────────
 * Two places decide what a card may say, and both work with an ALLOW-list so that the unknown stands out instead of vanishing:
 *
 *   consequencesOf   three step types are named (`knowledge_write`, `notification`, a `datatable` that WRITES); an explicit list of step types changes nothing outside the run; everything else is COUNTED, so the sentence can say that more happens than is stated. A step type that is added next year falls into that last bucket automatically.
 *
 *   triggerConditionOf  reads `tags` and `reprocessed`; EVERY other key in the filter — the DSL combinators any/none/expr/age from triggers/dslFilters.js, and whatever is added later — sets `extra`, because it narrows the rule in a way this sentence does not carry.
 */

export const RULE_TRIGGER_PROVIDER = 'meeting-notes';
const RULE_TRIGGER_EVENT = 'meeting.processed';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? v : []);

/** An automation step, as far as this card reads it. */
interface RuleStep {
    type?: unknown;
    op?: unknown;
    allowTools?: unknown;
    tools?: unknown;
    body?: unknown;
    branches?: unknown;
}

/** A trigger of an automation definition. */
interface RuleTrigger {
    kind?: string;
    appEvent?: { provider?: string; event?: unknown; filter?: unknown };
    [key: string]: unknown;
}

/** The part of an automation definition this card reads. */
interface RuleDefinition {
    trigger?: RuleTrigger;
    triggers?: unknown;
}

/** A row that may carry its owner under either name. */
type OwnedRow = RuleRow & { userId?: string; ownerId?: string };

/* ── de trigger ──────────────────────────────────────────────────────── */

/**
 * The meeting-notes triggers of a definition.
 *
 * Mirrors `appEventTriggersOf` in routes/automation/crud.js: the primary trigger PLUS the extra entry points in `triggers[]`, because an app_event may also stand there, and such a second trigger fires the rule just the same.
 */
export function meetingTriggersOf(definition: unknown) {
    const all = [(definition as RuleDefinition | null | undefined)?.trigger, ...list<RuleTrigger | undefined>((definition as RuleDefinition | null | undefined)?.triggers)];
    return all.filter((t): t is RuleTrigger => isObject(t) && t.kind === 'app_event' && t.appEvent?.provider === RULE_TRIGGER_PROVIDER);
}

/** Een tagwaarde uit een filter → lijst. Spiegelt `asTagList` van de matcher. */
function asTagList(v: unknown) {
    const raw = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
    return raw.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

// What this card may read from a trigger filter. An ALLOW-list, not a
// deny-list: a new key then automatically means "there is more going on".
const FILTER_KNOWN_KEYS = new Set(['tags', 'reprocessed']);

/**
 * The condition of a rule, or NULL if this is not a meeting-notes rule.
 *
 * `tags` is a UNION over the triggers, because the matcher matches on ANY of them and multiple triggers each fire separately. `extra` means "narrower than this sentence says" and is set as soon as a filter contains something we do not read, or as soon as two triggers have a different `reprocessed` setting (then there is no single setting that is true for the whole rule).
 */
export function triggerConditionOf(definition: unknown) {
    const triggers = meetingTriggersOf(definition);
    if (!triggers.length) return null;

    const tags: string[] = [];
    const seen = new Set<string>();
    const reprocessedSeen = new Set<boolean | undefined>();
    const events = new Set<string>();
    let extra = false;

    for (const trigger of triggers) {
        events.add(typeof trigger.appEvent?.event === 'string' ? trigger.appEvent.event : '');
        const filter: Record<string, unknown> = isObject(trigger.appEvent?.filter) ? trigger.appEvent.filter : {};
        for (const tag of asTagList(filter.tags)) {
            if (seen.has(tag)) continue;
            seen.add(tag);
            tags.push(tag);
        }
        reprocessedSeen.add(filter.reprocessed === true ? true : (filter.reprocessed === false ? false : undefined));
        for (const key of Object.keys(filter)) {
            if (!FILTER_KNOWN_KEYS.has(key) && filter[key] !== undefined) extra = true;
        }
    }

    if (reprocessedSeen.size > 1) extra = true;
    const reprocessed = reprocessedSeen.size === 1 ? [...reprocessedSeen][0] : undefined;
    // The EVENT travels along. `meetingTriggersOf` deliberately filters only on the PROVIDER, so that a later `meeting.scheduled` automatically lands in this list — but then the sentence may not unconditionally say "… is finished". That sentence did not scale and told the story of `meeting.processed` about every future event. Already reachable today: validate/graph.js turns an unknown app_event event into a WARNING, not an error, so an imported definition with an invented event lands in this list.
    const onlyProcessed = events.size === 1 && events.has(RULE_TRIGGER_EVENT);
    return { tags, reprocessed, extra, events: [...events], onlyProcessed };
}

/* ── de consequenties ────────────────────────────────────────────────── */

// Write ops of a datatable step (validate/constants.js
// DATATABLE_WRITE_OPS). Copied by hand, just as there: a new READ op must not quietly become a writer. A step WITHOUT an `op`, or with an op we do not know, therefore counts as unknown and not as a reader.
const DATATABLE_WRITE_OPS = new Set(['add_row', 'save_row', 'update_rows', 'delete_rows']);
const DATATABLE_READ_OPS = new Set(['find_rows', 'count_rows']);

/**
 * Step types that change nothing outside the run: calculating, branching, converting, waiting. They do not belong in the consequence sentence, and they are also not "more happens" — which is why they are listed here by name. Everything that is neither here nor in the three named types is counted and reported.
 *
 * `call_layer` is included because the content of that layer is walked separately (definition.layers) — otherwise it would count twice. `call_block` is NOT included: a Reusable Step lives in another document, and what it does is unknown from here.
 */
const NO_OUTWARD_EFFECT = new Set([
    'trigger', 'note',
    'condition', 'switch', 'guard', 'filter', 'flatten', 'limit', 'dedupe', 'aggregate', 'summarize',
    'set', 'datetime', 'parse_json', 'wait',
    'tokenize', 'untokenize',
    'loop', 'parallel', 'call_layer', 'layer_output',
    // `ai_step` is listed here ONLY for the tool-less variant: `reachesOutward` below is asked first and takes out the armed one. `code` is deliberately NOT included — it unconditionally gets an HTTP bridge.
    'ai_step',
]);

/**
 * `ai_step` and `code` were listed above, and that was fail-open: both can actually execute the user's INTEGRATION tools.
 *   - execAi.js opens the tool catalogue as soon as `step.allowTools` is true, and then runs a tool loop with `executeTool`. Without that flag it is a bare model call and nothing outside the run changes.
 *   - execOutbound.js ALWAYS gives a code step an HTTP bridge (`fetchHttp`), regardless of `step.allowedTools`. A code step therefore always reaches outward.
 * A rule with a single `ai_step {allowTools:true, tools:['gmail_send_email']}` mailed the customer the decisions from the note, while the card literally showed "nothing yet — this rule has no steps".
 */
function reachesOutward(step: RuleStep) {
    if (step.type === 'code') return true;
    if (step.type !== 'ai_step') return false;
    // An explicit allowlist also counts: today it does nothing without
    // `allowTools`, but the intention is clear, and unknown narrows.
    return !!step.allowTools || (Array.isArray(step.tools) && step.tools.length > 0);
}

/**
 * Every step of every graph: top-level, loop body, parallel branch.
 *
 * NO `step.cases`. A switch does not look like this in this product: the validator documents `cases: [{ name, value }]` — an ARRAY of DESCRIPTIONS — and the branches themselves run via EDGE labels, not via nesting. The canonical nested walker (validate/graph.js) therefore knows only two containers: `loop.body` and `parallel.branches`. A branch that treated `cases` as a map never fired on a real switch and only created the impression that switch nesting was covered.
 */
function walkSteps(steps: unknown, visit: (step: RuleStep) => void) {
    for (const step of list(steps)) {
        if (!isObject(step)) continue;
        visit(step);
        if (Array.isArray(step.body)) walkSteps(step.body, visit);
        if (Array.isArray(step.branches)) for (const branch of step.branches) walkSteps(branch, visit);
    }
}

/**
 * What happens to the note, derived from the step types.
 *
 * `readable: false` means that there was no step list IN the definition — that is something other than a rule without steps, and the card says so differently. (`definition_json` is parsed server-side with a fallback, so an unreadable definition arrives here as an object without `steps`.)
 */
export function consequencesOf(definition: unknown) {
    if (!isObject(definition) || !Array.isArray(definition.steps)) {
        return { readable: false, kb: false, notify: false, table: false, other: 0, steps: 0 };
    }
    // `steps` counts EVERY step, including the inert ones. "No steps" and
    // "only steps that this card marks as inert" are different answers, and the card
    // made one sentence of them: a rule with set + condition + parse_json got
    // "this rule has no steps" while three steps were there.
    const out = { readable: true, kb: false, notify: false, table: false, other: 0, steps: 0 };

    const visit = (step: RuleStep) => {
        const type = typeof step.type === 'string' ? step.type : '';
        if (type !== 'trigger') out.steps += 1;
        if (type === 'knowledge_write') { out.kb = true; return; }
        if (type === 'notification') { out.notify = true; return; }
        if (type === 'datatable') {
            if (DATATABLE_WRITE_OPS.has(step.op as string)) out.table = true;
            else if (!DATATABLE_READ_OPS.has(step.op as string)) out.other += 1;
            return;
        }
        if (reachesOutward(step)) { out.other += 1; return; }
        if (NO_OUTWARD_EFFECT.has(type)) return;
        out.other += 1;
    };

    walkSteps(definition.steps, visit);
    const layers = isObject(definition.layers) ? Object.values(definition.layers) : [];
    for (const layer of layers) if (isObject(layer)) walkSteps(layer.steps, visit);
    return out;
}

/* ── openen en tellen ────────────────────────────────────────────────── */

/**
 * May the reader open this rule? 'ok' | 'foreign' | 'unknown'.
 *
 * `GET /api/automation/:id` is a hard ownership check (403 as soon as `a.userId !== req.session.user.id`), so only a POSITIVE match gives a link. No owner in the row, or no known reader, is 'unknown': then there is no link AND no claim about whose rule it is.
 *
 * Deliberately STRICTER than `isForeignRow` of UsedByTab, which reads "no known owner" as "not someone else's": there the row is org-wide and that direction is correct; here the target is a route that returns 403 on exactly that difference.
 */
export function openability(row: OwnedRow, currentUserId: string | null | undefined) {
    const owner = row?.userId ?? row?.ownerId ?? null;
    if (!owner || !currentUserId) return 'unknown';
    return owner === currentUserId ? 'ok' : 'foreign';
}

/** Waar de regel woont. Uit de segmentkaart die de router zelf leest. */
export function ruleHref(automationId: string) {
    if (!automationId) return null;
    return `studio/${segmentForSection('aiTasks')}/${encodeURIComponent(automationId)}`;
}

/**
 * The count for one automation, or NULL if it is not there.
 *
 * `/_runs/facets` counts `r.user_id = <me>` (stores/automationStore/runs.js buildRunFilterWhere) — MY runs, not those of the organisation; the org variant is a different endpoint with its own permission check. Every sentence that uses this number must therefore say whose runs they are.
 */
export function runCountOf(facets: RunFacets, automationId: string | undefined) {
    const byId = facets?.automationId;
    if (!isObject(byId)) return null;          // onleesbaar — zie facetsReadable
    const n = byId[automationId as string];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;         // read and not found = a real zero
}

/**
 * Is this facets answer readable?
 *
 * A 200 with a body without an `automationId` map is NOT a zero: then nobody has counted. `runCountOf` gave `null` for both, and the card made "no runs of yours" of it — a claim about runs that were not counted. The panel uses this to show the same banner as for a failed read.
 */
export function facetsReadable(facets: RunFacets | null) {
    return isObject(facets) && isObject(facets.automationId);
}

/* ── nieuwe regel ────────────────────────────────────────────────────── */

/**
 * The draft that "+ Rule" creates: the trigger is already right, the rest is not.
 *
 * An EMPTY filter, deliberately: that means EVERY completed meeting note, and the filter form in the builder says so in so many words as soon as you are there (triggerFilters.jsx). An invented tag filter would make a rule that quietly does less than its author thinks.
 */
export function newRuleDefinition() {
    return {
        schemaVersion: 1,
        trigger: {
            id: 'trg',
            type: 'trigger',
            kind: 'app_event',
            label: 'Meeting note ready',
            appEvent: { provider: RULE_TRIGGER_PROVIDER, event: RULE_TRIGGER_EVENT, filter: {} },
        },
        steps: [],
        edges: [],
        vars: {},
    };
}

/* ── de AI-composer ──────────────────────────────────────────────────── */

/**
 * The seed that the suggestion scan keeps within this topic.
 *
 * The server truncates `focus` to 280 characters (routes/ai/automationBuilder/suggestions.js), so the seed goes at the FRONT: whatever the user types after it may drop away, the scope may not.
 */
export const COMPOSER_SEED = 'Rules that run on a finished Bee Flow meeting note (trigger: Meeting Notes, meeting.processed). Prefer steps that file the note in a knowledge base, send a notification, or write a datatable row.';

export function composerSeed(userText: string) {
    const extra = typeof userText === 'string' ? userText.replace(/\s+/g, ' ').trim() : '';
    return extra ? `${COMPOSER_SEED} Wanted: ${extra}` : COMPOSER_SEED;
}
