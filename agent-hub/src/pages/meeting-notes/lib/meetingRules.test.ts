/**
 * What a rule IS on a meeting note (M5, part D).
 *
 * Three claims have gone wrong earlier in this program, and each is listed below by name:
 *   1. a step type that this card does not know does not silently disappear from the consequence — it is counted, so the sentence can name it;
 *   2. a filter key that the card does not read does not silently narrow;
 *   3. a rule that the reader may not open gets no link, because `GET /api/automation/:id` returns 403 there.
 */
import { describe, expect, it } from 'vitest';
import {
    COMPOSER_SEED,
    composerSeed,
    consequencesOf,
    facetsReadable,
    meetingTriggersOf,
    newRuleDefinition,
    openability,
    ruleHref,
    runCountOf,
    triggerConditionOf,
} from './meetingRules';
import { partial, malformed, stub } from '@/test/mocks';

const meetingTrigger = (filter = {}) => ({
    id: 'trg', type: 'trigger', kind: 'app_event',
    appEvent: { provider: 'meeting-notes', event: 'meeting.processed', filter },
});

describe('meetingTriggersOf', () => {
    it('takes the primary trigger and the extra entry points, and nothing else', () => {
        const def = {
            trigger: meetingTrigger(),
            triggers: [
                meetingTrigger({ tags: ['x'] }),
                { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } },
                { kind: 'schedule' },
                null,
            ],
        };
        expect(meetingTriggersOf(def)).toHaveLength(2);
        expect(meetingTriggersOf({ trigger: { kind: 'manual' } })).toEqual([]);
        expect(meetingTriggersOf(undefined)).toEqual([]);
    });
});

describe('triggerConditionOf', () => {
    it('is null for a definition that does not start on a meeting note', () => {
        expect(triggerConditionOf({ trigger: { kind: 'manual' }, steps: [] })).toBeNull();
        expect(triggerConditionOf(null)).toBeNull();
    });

    it('unions the tags over every meeting trigger, primary and secondary', () => {
        const cond = triggerConditionOf({
            trigger: meetingTrigger({ tags: ['sales', 'sales'] }),
            triggers: [meetingTrigger({ tags: 'support' }), { kind: 'webhook' }],
        });
        expect(cond!.tags).toEqual(['sales', 'support']);
        expect(cond!.extra).toBe(false);
    });

    it('reads the three-valued reprocessed, and only when every trigger agrees', () => {
        expect(triggerConditionOf({ trigger: meetingTrigger({}) })!.reprocessed).toBeUndefined();
        expect(triggerConditionOf({ trigger: meetingTrigger({ reprocessed: false }) })!.reprocessed).toBe(false);
        expect(triggerConditionOf({ trigger: meetingTrigger({ reprocessed: true }) })!.reprocessed).toBe(true);

        const mixed = triggerConditionOf({
            trigger: meetingTrigger({ reprocessed: true }),
            triggers: [meetingTrigger({ reprocessed: false })],
        });
        expect(mixed!.reprocessed).toBeUndefined();
        expect(mixed!.extra).toBe(true);
    });

    it('flags a filter key it cannot read — the DSL today, anything added later', () => {
        // any/none/expr/age narrow the rule further (triggers/dslFilters.js).
        expect(triggerConditionOf({ trigger: meetingTrigger({ tags: ['x'], expr: 'trigger.tags != null' }) })!.extra).toBe(true);
        expect(triggerConditionOf({ trigger: meetingTrigger({ none: [{ tags: ['secret'] }] }) })!.extra).toBe(true);
        // A key nobody has written yet must land in the same bucket, not vanish.
        expect(triggerConditionOf({ trigger: meetingTrigger({ attendeeCountAtLeast: 3 }) })!.extra).toBe(true);
        // An explicitly-undefined key is not a condition.
        expect(triggerConditionOf({ trigger: meetingTrigger({ tags: ['x'], expr: undefined }) })!.extra).toBe(false);
    });
});

describe('consequencesOf', () => {
    const def = (steps: unknown[], extra = {}) => ({ trigger: meetingTrigger(), steps, edges: [], ...extra });

    it('names the three step kinds it can describe', () => {
        const out = consequencesOf(def([
            { id: 'a', type: 'knowledge_write' },
            { id: 'b', type: 'notification' },
            { id: 'c', type: 'datatable', op: 'add_row' },
        ]));
        expect(out).toMatchObject({ readable: true, kb: true, notify: true, table: true, other: 0 });
    });

    it('finds them inside a loop body, a parallel branch and a layer', () => {
        // NOT a nested `switch.cases`. A switch does not look like this in this product: stepRules documents `cases: [{ name, value }]` — an ARRAY of descriptions — and the branches run via EDGE labels, so the steps of a case simply sit top-level. The old fixture built a shape that the builder and the validator never produce, and was therefore green without testing anything real.
        const out = consequencesOf(def(
            [
                { id: 'l', type: 'loop', body: [{ id: 'l1', type: 'knowledge_write' }] },
                { id: 'p', type: 'parallel', branches: [[{ id: 'p1', type: 'notification' }]] },
                { id: 's', type: 'switch', cases: [{ name: 'a', value: 'x' }] },
                { id: 's1', type: 'datatable', op: 'save_row' },
                { id: 'c', type: 'call_layer', layerKey: 'sub' },
            ],
            { layers: { sub: { steps: [{ id: 'x1', type: 'http_request' }] } } },
        ));
        expect(out).toMatchObject({ kb: true, notify: true, table: true });
        // The layer's own step is the one unknown thing; call_layer itself is
        // not counted a second time.
        expect(out.other).toBe(1);
    });

    it('counts a step kind it does not know instead of dropping it', () => {
        const out = consequencesOf(def([
            { id: 'a', type: 'knowledge_write' },
            { id: 'b', type: 'integration_action', tool: 'gmail_send' },
            { id: 'c', type: 'teleporter_9000' },   // a type from next year
        ]));
        expect(out.kb).toBe(true);
        expect(out.other).toBe(2);
    });

    it('does not count plumbing that changes nothing outside the run', () => {
        const out = consequencesOf(def([
            { id: 'a', type: 'ai_step' }, { id: 'b', type: 'condition' }, { id: 'c', type: 'set' },
            { id: 'd', type: 'parse_json' }, { id: 'e', type: 'note' }, { id: 'f', type: 'guard' },
        ]));
        expect(out).toMatchObject({ kb: false, notify: false, table: false, other: 0 });
        // …but there ARE steps, and that is something other than an empty rule.
        expect(out.steps).toBe(6);
    });

    it('EEN AI-STAP MET TOOLS VERANDERT WEL DEGELIJK IETS BUITEN DE RUN', () => {
        // execAi opent de toolcatalogus zodra `allowTools` waar is en draait
        // daarna een tool-loop met `executeTool`. Een regel met één zo'n stap
        // mailde de klant de besluiten uit de notitie terwijl de kaart
        // "nothing yet — this rule has no steps" toonde.
        const armed = consequencesOf(def([{ id: 'a', type: 'ai_step', allowTools: true, tools: ['gmail_send_email'] }]));
        expect(armed.other).toBe(1);
        // An explicit allowlist without `allowTools` also counts: unknown narrows.
        expect(consequencesOf(def([{ id: 'a', type: 'ai_step', tools: ['gmail_send_email'] }])).other).toBe(1);
        // Without tools it is a bare model call and nothing changes outside.
        expect(consequencesOf(def([{ id: 'a', type: 'ai_step' }])).other).toBe(0);
        expect(consequencesOf(def([{ id: 'a', type: 'ai_step', tools: [] }])).other).toBe(0);
    });

    it('een code-stap reikt ALTIJD naar buiten — hij krijgt onvoorwaardelijk een HTTP-brug', () => {
        // execOutbound geeft de sandbox `fetchHttp` los van `allowedTools`.
        expect(consequencesOf(def([{ id: 'a', type: 'code' }])).other).toBe(1);
        expect(consequencesOf(def([{ id: 'a', type: 'code', allowedTools: [] }])).other).toBe(1);
    });

    it('a datatable that only reads is not a write, and an unknown op is not a read', () => {
        expect(consequencesOf(def([{ id: 'a', type: 'datatable', op: 'find_rows' }])))
            .toMatchObject({ table: false, other: 0 });
        expect(consequencesOf(def([{ id: 'a', type: 'datatable', op: 'delete_rows' }])))
            .toMatchObject({ table: true, other: 0 });
        // No op yet, or an op this list has never heard of: unknown, so it is
        // reported rather than quietly filed as harmless.
        expect(consequencesOf(def([{ id: 'a', type: 'datatable' }]))).toMatchObject({ table: false, other: 1 });
        expect(consequencesOf(def([{ id: 'a', type: 'datatable', op: 'truncate_everything' }])))
            .toMatchObject({ table: false, other: 1 });
    });

    it('tells "no steps" apart from "no step list"', () => {
        expect(consequencesOf(def([])).readable).toBe(true);
        expect(consequencesOf({ trigger: meetingTrigger() }).readable).toBe(false);
        expect(consequencesOf(null).readable).toBe(false);
    });
});

describe('openability', () => {
    it('links only what the reader positively owns', () => {
        expect(openability(partial<Parameters<typeof openability>[0]>({ userId: 'me' }), 'me')).toBe('ok');
        expect(openability(partial<Parameters<typeof openability>[0]>({ userId: 'you' }), 'me')).toBe('foreign');
        // Unknown narrows: no owner on the row, or no signed-in id, is not a
        // licence to link at a route that 403s on exactly this.
        expect(openability(malformed<Parameters<typeof openability>[0]>({}), 'me')).toBe('unknown');
        expect(openability(partial<Parameters<typeof openability>[0]>({ userId: 'me' }), null)).toBe('unknown');
        expect(openability(stub<Parameters<typeof openability>[0]>(null), 'me')).toBe('unknown');
    });
});

describe('runCountOf', () => {
    it('scheidt ONLEESBAAR van een echte nul', () => {
        expect(runCountOf({ automationId: { 'a-1': 3 } }, 'a-1')).toBe(3);
        expect(runCountOf({ automationId: { 'a-1': 0 } }, 'a-1')).toBe(0);
        // The folder is there and this automation is not in it: a real zero.
        expect(runCountOf({ automationId: {} }, 'a-1')).toBe(0);
        // No folder: then NOBODY has counted. That was the same answer as above, and the card turned it into "no runs of yours" — a claim about runs that were not counted.
        expect(runCountOf(stub<Parameters<typeof runCountOf>[0]>(null), 'a-1')).toBeNull();
        expect(runCountOf(stub<Parameters<typeof runCountOf>[0]>({ status: {} }), 'a-1')).toBeNull();
        expect(runCountOf({ automationId: { 'a-1': 'lots' } }, 'a-1')).toBe(0);
    });
});

describe('facetsReadable', () => {
    it('zegt of er überhaupt geteld is', () => {
        expect(facetsReadable({ automationId: {} })).toBe(true);
        expect(facetsReadable({ automationId: { 'a-1': 2 } })).toBe(true);
        expect(facetsReadable(stub<Parameters<typeof facetsReadable>[0]>({ status: {} }))).toBe(false);   // 200, andere vorm
        expect(facetsReadable(null)).toBe(false);
        expect(facetsReadable(stub<Parameters<typeof facetsReadable>[0]>(undefined))).toBe(false);
    });
});

describe('ruleHref', () => {
    it('uses the segment the router itself parses', () => {
        expect(ruleHref('a-1')).toBe('studio/automations/a-1');
        expect(ruleHref('a/1')).toBe('studio/automations/a%2F1');
        expect(ruleHref(stub<Parameters<typeof ruleHref>[0]>(null))).toBeNull();
    });
});

describe('newRuleDefinition', () => {
    it('is the meeting trigger and nothing else', () => {
        const def = newRuleDefinition();
        expect(def.trigger).toMatchObject({
            kind: 'app_event',
            appEvent: { provider: 'meeting-notes', event: 'meeting.processed', filter: {} },
        });
        expect(def.steps).toEqual([]);
        expect(def.edges).toEqual([]);
    });
});

describe('composerSeed', () => {
    it('puts the scope first, because the server truncates at 280', () => {
        expect(COMPOSER_SEED.length).toBeLessThan(280);
        const seeded = composerSeed('  put   decisions in the sales wiki ');
        expect(seeded.startsWith(COMPOSER_SEED)).toBe(true);
        expect(seeded).toContain('put decisions in the sales wiki');
        expect(composerSeed('')).toBe(COMPOSER_SEED);
        expect(composerSeed(stub<Parameters<typeof composerSeed>[0]>(undefined))).toBe(COMPOSER_SEED);
    });
});
