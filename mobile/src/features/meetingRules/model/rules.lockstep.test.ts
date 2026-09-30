/**
 * Differential: the port and agent-hub's meetingRules.js read the same
 * definitions the same way. When this fails the web side changed — update
 * rules.ts.
 */

import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import {
    consequencesOf,
    facetsReadable,
    newRuleDefinition,
    openability,
    runCountOf,
    triggerConditionOf,
} from './rules';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/pages/meeting-notes/lib/meetingRules.js');
// Its one import, used only by ruleHref (the web's own URL), which the phone does not port.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const web: any = loadWebModule(WEB, { segmentForSection: () => 'automations' });

const trigger = (filter: unknown, event = 'meeting.processed') => ({
    kind: 'app_event',
    appEvent: { provider: 'meeting-notes', event, filter },
});

const DEFINITIONS: unknown[] = [
    null,
    {},
    { trigger: { kind: 'schedule' }, steps: [] },
    { trigger: trigger({}), steps: [] },
    { trigger: trigger({ tags: 'sales' }), steps: [{ type: 'knowledge_write' }] },
    { trigger: trigger({ tags: ['a', ' b ', ''] }), triggers: [trigger({ tags: ['b', 'c'], reprocessed: true })], steps: [] },
    { trigger: trigger({ reprocessed: false, any: [] }), steps: [{ type: 'set' }, { type: 'condition' }] },
    { trigger: trigger({}, 'meeting.scheduled'), steps: [] },
    { trigger: trigger({}, ''), steps: [] },
    {
        trigger: trigger({}),
        steps: [
            { type: 'notification' },
            { type: 'datatable', op: 'add_row' },
            { type: 'datatable', op: 'find_rows' },
            { type: 'datatable', op: 'mystery' },
            { type: 'ai_step' },
            { type: 'ai_step', allowTools: true },
            { type: 'ai_step', tools: ['gmail_send_email'] },
            { type: 'code' },
            { type: 'loop', body: [{ type: 'http_request' }] },
            { type: 'parallel', branches: [[{ type: 'notification' }], [{ type: 'wait' }]] },
            'not a step',
        ],
        layers: { l1: { steps: [{ type: 'knowledge_write' }] }, l2: 'junk' },
    },
];

describe('rules.ts matches meetingRules.js', () => {
    it.each(DEFINITIONS.map((d, i) => [i, d]))('definition %i', (_i, definition) => {
        expect(triggerConditionOf(definition)).toEqual(web.triggerConditionOf(definition));
        expect(consequencesOf(definition)).toEqual(web.consequencesOf(definition));
    });

    it('decides who may open a rule the same way', () => {
        const rows = [{ userId: 'me' }, { userId: 'you' }, { ownerId: 'me' }, {}];
        for (const row of rows) {
            for (const reader of ['me', null]) expect(openability(row, reader)).toBe(web.openability(row, reader));
        }
    });

    it('counts runs the same way, unknown apart from zero', () => {
        const facetsList = [null, {}, { automationId: {} }, { automationId: { r1: 3, r2: 'x' } }];
        for (const facets of facetsList) {
            for (const id of ['r1', 'r2', 'r3']) expect(runCountOf(facets, id)).toBe(web.runCountOf(facets, id));
            expect(facetsReadable(facets)).toBe(web.facetsReadable(facets));
        }
    });

    it('makes the same draft', () => {
        expect(newRuleDefinition()).toEqual(web.newRuleDefinition());
    });
});
