/**
 * Lockstep: the assistant sheet against the web builder's chat.
 *
 *   DIFFERENTIAL  activity.ts ↔ chat/toolCallDisplay.js: the same raw tool
 *                 calls — read on the phone through the stream's own reader
 *                 (api/builder.ts readToolCall) — describe as the same rows.
 *                 The web's integration table is emptied (and the phone given
 *                 no catalog), so an app action falls back to its type on both
 *                 sides; lucide is a name proxy, as in the canvas tests.
 *   DIFFERENTIAL  welcome.ts ↔ chat/AssistantWelcome.tsx (welcomeIdeas),
 *                 chat/exampleBriefs.ts and emptyDraft.ts: the ideas logic,
 *                 cut out of the web component and run beside the port for
 *                 each trigger, step count, selected step and kind of step.
 */

import path from 'node:path';

import { readToolCall } from '@/features/flow-editor/api/builder';
import { loadWebFunctions, loadWebModule } from '@/shared/testing/webModule';

import { describeLiveRun, describeToolCall } from './activity';
import { exampleBriefs, isEmptyDraft, welcomeOffers, welcomeSuggestions, type WelcomeDefinition, type WelcomeStep } from './welcome';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });
jest.mock('../../../../../../agent-hub/src/utils/integrationIcons', () => ({
    INTEGRATION_META: {},
    resolveIntegrationFromTool: () => null,
}));

const CHAT = path.resolve(__dirname, '../../../../../../agent-hub/src/components/automation/Builder/chat');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require(`${CHAT}/toolCallDisplay.ts`);

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const CALLS: unknown[] = [
    { name: 'builder_add_step', result: { added: { id: 's1', type: 'ai_step', label: 'Summarise' } } },
    { name: 'builder_add_step', result: { added: { id: 's2', type: 'integration_action', tool: 'gmail_send_email' } } },
    { name: 'builder_add_steps', result: { added: [{ id: 'a', type: 'set' }, { id: 'b', type: 'integration_action', tool: 'x_y' }, 'junk', null] } },
    { name: 'builder_add_steps', result: { added: [{ id: 'a', type: 'integration_action' }, { id: 'b', type: 'integration_action' }] } },
    { name: 'builder_add_steps', result: { added: [{ id: 'only', type: 'wait' }] } },
    { name: 'builder_add_steps', result: { added: [] } },
    { name: 'builder_remove_step', result: { ok: true } },
    { name: 'builder_update_steps', result: { error: 'Step s9 does not exist', _fixHint: 'Use an id from the draft' } },
    { name: 'builder_finalize', result: {} },
    { name: 'builder_add_brand_new_thing', result: {} },
    { name: 'builder_add_step', result: { added: { type: 'no_such_type' } } },
    { name: '', result: 'text' },
    { name: 'builder_set_plan' },
    { name: 'builder_add_array_op', arguments: { op: 'flatten' }, result: { error: 'No list called attachments' } },
    { name: 'builder_add_array_op', arguments: { op: 'flatten' }, result: { added: { id: 'f1', type: 'flatten', label: 'One row per attachment' } } },
    { name: 'builder_add_array_op', arguments: { op: 'limit' }, result: { error: 'x' } },
    { name: 'builder_propose_trigger', result: {} },
    { name: 'builder_request_dry_run', result: {} },
    { name: 'builder_ask_questions', result: {} },
    { name: 'builder_inspect_mapping', result: {} },
    { name: 'agent_search', arguments: { query: 'opening hours' }, result: {} },
    { name: 'read_url', arguments: { url: 'https://example.com/a' }, result: {} },
    { name: 'read_url', result: {} },
];

describe('the activity rows', () => {
    it.each(CALLS.map((c, i) => [i, c] as const))('call %i reads as the web reads it', (_i, raw) => {
        const mine = describeToolCall(readToolCall(raw), t);
        const theirs = web.describeToolCall(raw, t);
        expect(mine).toEqual(theirs);
    });

    it('describes a live test run as the web does', () => {
        for (const focus of [null, {}, { label: 'Read file', done: 1, total: 4 }, { done: 9, total: 3 }, { label: 'x', done: -1, total: 0 }]) {
            expect(describeLiveRun(focus, t)).toEqual(web.describeLiveRun(focus, t));
        }
    });
});

describe('the welcome', () => {
    // The web's idea logic, run as the web wrote it: welcomeIdeas and the
    // helper it calls, cut out of the component file (which also holds JSX).
    const WELCOME = 'components/automation/Builder/chat/AssistantWelcome.tsx';
    const webWelcome = loadWebFunctions<{ welcomeIdeas: (definition: unknown, selectedStep: unknown, tr: typeof t) => string[] }>(WELCOME, ['notifies', 'welcomeIdeas']);
    const { exampleBriefs: webBriefs } = loadWebModule<{ exampleBriefs: (tr: typeof t) => string[] }>('components/automation/Builder/chat/exampleBriefs.ts');
    const { isEmptyDraft: webIsEmpty } = loadWebModule<{ isEmptyDraft: (definition: unknown) => boolean }>('components/automation/Builder/emptyDraft.ts');
    const flow = (kind: string, steps: WelcomeStep[]) => ({ trigger: { id: 'trg', type: 'trigger', kind }, steps, edges: [] });
    const many = (count: number, type: string) => Array.from({ length: count }, (_, i) => ({ id: `s${i}`, type }));

    it('reads the web suggestions at all', () => {
        expect(webWelcome.welcomeIdeas(flow('schedule', []), null, t)).toEqual(['Summarise the latest activity and email me a digest']);
        expect(webWelcome.welcomeIdeas(flow('manual', many(3, 'set')), null, t)).toHaveLength(3);
        expect(webBriefs(t)).toHaveLength(3);
    });

    it.each(['schedule', 'app_event', 'webhook', 'manual', 'form'])('offers the web suggestions for a %s trigger, empty or with steps', (kind) => {
        for (const steps of [0, 1, 3]) {
            const definition = flow(kind, many(steps, 'set'));
            expect(welcomeSuggestions(definition, t)).toEqual(webWelcome.welcomeIdeas(definition, null, t));
        }
    });

    it.each(['code', 'ai_step', 'set'])('offers the web suggestions for a selected %s step', (type) => {
        for (const steps of [0, 2]) {
            const definition = flow('schedule', many(steps, type));
            const selectedStep = { id: 's0', type };
            expect(welcomeSuggestions(definition, t, selectedStep)).toEqual(webWelcome.welcomeIdeas(definition, selectedStep, t));
        }
    });

    it.each([
        ['a notification', [{ id: 'a', type: 'notification' }]],
        ['an app action that sends mail', [{ id: 'a', type: 'integration_action', tool: 'GMAIL_Send_Email' }]],
        ['an app action that only reads', [{ id: 'a', type: 'integration_action', tool: 'drive_list' }]],
        ['a condition', [{ id: 'a', type: 'condition' }]],
        ['a switch', [{ id: 'a', type: 'switch' }]],
        ['a table write', [{ id: 'a', type: 'datatable' }]],
    ] as const)('reads a flow with %s as the web does', (_label, steps) => {
        for (const kind of ['form', 'schedule']) {
            const definition = flow(kind, [...steps]);
            expect(welcomeSuggestions(definition, t)).toEqual(webWelcome.welcomeIdeas(definition, null, t));
        }
    });

    it('offers the web’s example briefs on a draft nobody has built in yet', () => {
        expect(exampleBriefs(t)).toEqual(webBriefs(t));
        const drafts: unknown[] = [
            null, {}, { steps: [] }, flow('manual', []), flow('form', []), flow('manual', many(1, 'set')),
            { ...flow('manual', []), triggers: [{ id: 't2', type: 'trigger', kind: 'webhook' }] }, { trigger: { id: 'trg', type: 'trigger' }, steps: [] },
        ];
        for (const definition of drafts) {
            expect(isEmptyDraft(definition as WelcomeDefinition)).toBe(webIsEmpty(definition));
            const web = webIsEmpty(definition) ? webBriefs(t) : webWelcome.welcomeIdeas(definition, null, t);
            expect(welcomeOffers(definition as WelcomeDefinition, t)).toEqual(web);
        }
    });
});
