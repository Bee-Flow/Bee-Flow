/**
 * Lockstep: the assistant sheet against the web builder's chat.
 *
 *   DIFFERENTIAL  activity.ts ↔ chat/toolCallDisplay.js: the same raw tool
 *                 calls — read on the phone through the stream's own reader
 *                 (api/builder.ts readToolCall) — describe as the same rows.
 *                 The web's integration table is emptied (and the phone given
 *                 no catalog), so an app action falls back to its type on both
 *                 sides; lucide is a name proxy, as in the canvas tests.
 *   DIFFERENTIAL  welcome.ts ↔ chat/AssistantWelcome.jsx: the suggestion
 *                 logic, cut out of the web component and run beside the
 *                 port for each trigger, step count and selected step.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readToolCall } from '@/features/flow-editor/api/builder';

import { describeLiveRun, describeToolCall } from './activity';
import { welcomeSuggestions } from './welcome';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });
jest.mock('../../../../../../agent-hub/src/utils/integrationIcons', () => ({
    INTEGRATION_META: {},
    resolveIntegrationFromTool: () => null,
}));

const CHAT = path.resolve(__dirname, '../../../../../../agent-hub/src/components/automation/Builder/chat');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require(`${CHAT}/toolCallDisplay.js`);

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
    const src = fs.readFileSync(`${CHAT}/AssistantWelcome.jsx`, 'utf8');
    // The web's chip logic, cut out of its component and run beside the port:
    // from `const steps` to the JSX, with its icons as plain names.
    const body = src.slice(src.indexOf('const steps ='), src.indexOf('return <div'));
    const icons = (/import \{([^}]+)\} from 'lucide-react'/.exec(src)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const webChips = new Function('triggerKind', 'definition', 'selectedStep', 't', ...icons, `${body}\nreturn chips.slice(0, 4).map((c) => c.text);`) as (
        triggerKind: string,
        definition: unknown,
        selectedStep: unknown,
        tr: typeof t,
        ...names: string[]
    ) => string[];

    it('reads the web suggestions at all', () => {
        expect(icons.length).toBeGreaterThan(3);
        expect(body).toContain('chips');
    });

    it.each(['schedule', 'app_event', 'webhook', 'manual', 'form'])('offers the web suggestions for a %s trigger, empty or with steps', (kind) => {
        for (const steps of [0, 1, 3]) {
            const definition = { steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, type: 'set' })) };
            expect(welcomeSuggestions(kind, t, { steps })).toEqual(webChips(kind, definition, null, t, ...icons));
        }
    });

    it.each(['code', 'ai_step', 'set'])('offers the web suggestions for a selected %s step', (type) => {
        for (const steps of [0, 2]) {
            const definition = { steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, type })) };
            const selectedStep = { id: 's0', type };
            expect(welcomeSuggestions('schedule', t, { steps, selectedStep })).toEqual(webChips('schedule', definition, selectedStep, t, ...icons));
        }
    });
});
