/**
 * The builder adapter against both ends of the stream, read as TEXT:
 *
 *   - the SERVER: every event name routes/ai/automationBuilder writes onto the
 *     builder stream (`send('x'`, `sendRaw('x'`, the narrator's `emit('x'`)
 *     and the heartbeat's `ping`;
 *   - the WEB: every `case 'x'` of agent-hub/src/hooks/
 *     useAutomationBuilderStream.ts.
 *
 * Each must be accounted for by the adapter — routed, or IGNORE, which is a
 * decision — so a new event fails here until somebody decides what the phone
 * does with it, instead of falling through to `onUnhandled`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { accounts } from '@/shared/stream';

import { builderFrames } from './builderStream';

const REPO = path.resolve(__dirname, '../../../../..');
const BUILDER = path.join(REPO, 'server/routes/ai/automationBuilder');

/** The files that write onto POST /builder/stream. */
const STREAM_WRITERS = ['chatStream.js', 'modelStream.js', 'thoughtNarrator.js', 'layerDelegation.js'];

function serverEvents(): string[] {
    const source = STREAM_WRITERS.map((f) => fs.readFileSync(path.join(BUILDER, f), 'utf8')).join('\n');
    const names = [...source.matchAll(/\b(?:send|sendRaw|emit)\(\s*'([a-z_]+)'/g)].map((m) => m[1] as string);
    return [...new Set([...names, 'ping'])].sort();
}

function webEvents(): string[] {
    const source = fs.readFileSync(path.join(REPO, 'agent-hub/src/hooks/useAutomationBuilderStream.ts'), 'utf8');
    return [...new Set([...source.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1] as string))].sort();
}

const adapter = builderFrames(() => ({}));

describe('the builder stream vocabulary', () => {
    it('reads enough of both sides for the check to mean something', () => {
        expect(serverEvents().length).toBeGreaterThan(20);
        expect(webEvents().length).toBeGreaterThan(20);
        expect(serverEvents()).toEqual(expect.arrayContaining(['draft', 'validation_errors', 'tool_call', 'plan', 'dryrun', 'finalized', 'done', 'error']));
    });

    it('accounts for every event the server writes onto the stream', () => {
        expect(serverEvents().filter((e) => !accounts(adapter, e))).toEqual([]);
    });

    it('accounts for every event the web builder handles', () => {
        expect(webEvents().filter((e) => !accounts(adapter, e))).toEqual([]);
    });

    it('routes nothing that neither side knows', () => {
        const known = new Set([...serverEvents(), ...webEvents()]);
        expect(Object.keys(adapter).filter((e) => !known.has(e))).toEqual([]);
    });
});
