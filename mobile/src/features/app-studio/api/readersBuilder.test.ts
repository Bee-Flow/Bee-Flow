/**
 * The builder's snapshot and events through the allow-list, plus the
 * lockstep with the server: every `send('<event>'` in the builder route must
 * have a reader here, and every reader must name an event the server still
 * sends. The server file is read as text (it imports the database pool).
 */

import fs from 'node:fs';
import path from 'node:path';

import { BUILDER_EVENT_TYPES, readBuilderEvent, readBuilderSession } from './readersBuilder';

const BUILDER_DIR = path.resolve(__dirname, '../../../../../server/routes/ai/appStudioBuilder');

function serverEventNames(): string[] {
    const names = new Set<string>();
    for (const file of fs.readdirSync(BUILDER_DIR)) {
        if (!file.endsWith('.js') || file.includes('.test.')) continue;
        const source = fs.readFileSync(path.join(BUILDER_DIR, file), 'utf8');
        for (const m of source.matchAll(/\bsend\(\s*'([a-z_]+)'/g)) names.add(m[1] as string);
    }
    return [...names].sort();
}

describe('builder events lockstep (server/routes/ai/appStudioBuilder)', () => {
    const emitted = serverEventNames();

    it('finds enough events to be meaningful', () => {
        expect(emitted.length).toBeGreaterThan(15);
    });

    it('reads every event the server sends', () => {
        expect(emitted.filter((e) => !(BUILDER_EVENT_TYPES as string[]).includes(e))).toEqual([]);
    });

    it('reads no event the server stopped sending', () => {
        expect(BUILDER_EVENT_TYPES.filter((e) => !emitted.includes(e))).toEqual([]);
    });
});

describe('readBuilderEvent', () => {
    it('types a known event and drops unknown fields', () => {
        expect(readBuilderEvent('tool_call', {
            name: 'app_add_screen', label: 'Add screen', ok: true, summary: 'Added Home',
            added: [{ id: 's1', type: 'screen', label: 'Home' }], arguments: '{}', result: '{}',
        })).toEqual({
            type: 'tool_call', name: 'app_add_screen', label: 'Add screen', ok: true, summary: 'Added Home',
            added: [{ id: 's1', type: 'screen', label: 'Home' }], error: null, hint: null,
        });
    });

    it('tells the plan artifact from the checklist', () => {
        expect(readBuilderEvent('plan', { planId: 'p1', plan: { phases: [] } })).toEqual({
            type: 'plan', planId: 'p1', plan: { phases: [] }, todos: null,
        });
        expect(readBuilderEvent('plan', { todos: [{ text: 'Tables', done: true }] })).toEqual({
            type: 'plan', planId: null, plan: null, todos: [{ text: 'Tables', done: true }],
        });
    });

    it('reads a draft and an error', () => {
        expect(readBuilderEvent('draft', { appId: 'a', definition: { screens: [] }, version: 7 })).toEqual({
            type: 'draft', appId: 'a', definition: { screens: [] }, version: 7,
        });
        expect(readBuilderEvent('error', { message: 'Slow down', code: 'rate_limited' })).toEqual({
            type: 'error', message: 'Slow down', code: 'rate_limited',
        });
    });

    it('passes an unknown event through as unknown rather than dropping it', () => {
        expect(readBuilderEvent('brand_new', { x: 1 })).toEqual({ type: 'unknown', event: 'brand_new', data: { x: 1 } });
        expect(readBuilderEvent('toString', {})).toMatchObject({ type: 'unknown' });
    });
});

describe('readBuilderSession', () => {
    it('reads the snapshot and defaults the plan-first keys', () => {
        const session = readBuilderSession({
            snapshot: {
                sessionId: 's1', appId: 'a', version: 3, lastTier: 'fast',
                messages: [{ role: 'user', content: 'Make a CRM' }, { role: 'system', content: 'x' }],
                todos: [{ text: 'Screens', done: false }],
            },
        });
        expect(session).toMatchObject({
            sessionId: 's1', version: 3, lastTier: 'fast', pendingPlan: null, approvedPlan: null, continueToken: null,
        });
        expect(session?.messages).toEqual([
            { role: 'user', content: 'Make a CRM' },
            { role: 'assistant', content: 'x' },
        ]);
        expect(readBuilderSession({})).toBeNull();
    });
});
