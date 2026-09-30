/**
 * Lockstep: the assistant sheet against the web builder's chat.
 *
 *   DIFFERENTIAL  activity.ts ↔ chat/toolCallDisplay.js: the same raw tool
 *                 calls — read on the phone through the stream's own reader
 *                 (api/builder.ts readToolCall) — describe as the same rows.
 *                 The web's integration table is emptied (and the phone given
 *                 no catalog), so an app action falls back to its type on both
 *                 sides; lucide is a name proxy, as in the canvas tests.
 *   TEXTUAL       welcome.ts ↔ chat/AssistantWelcome.jsx: the suggestions
 *                 and which trigger picks the first.
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

    it('offers the web suggestions, the first by trigger', () => {
        const cases: [string, string | null][] = [['schedule', 'schedule'], ['app_event', 'app_event'], ['webhook', 'webhook'], ['manual', null], ['form', null]];
        for (const [kind, branch] of cases) {
            const [first, ...rest] = welcomeSuggestions(kind, t);
            if (branch) expect(src).toMatch(new RegExp(`triggerKind === '${branch}'\\) chips\\.push\\('${first}'\\)`));
            else expect(src).toContain(`else chips.push('${first}')`);
            for (const chip of rest) expect(src).toContain(`chips.push('${chip}')`);
        }
    });
});
