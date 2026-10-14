/**
 * The builder adapter against both ends of the stream, read as TEXT:
 *
 *   - the SERVER: every event name routes/ai/automationBuilder writes onto the
 *     builder stream (`send('x'`, `sendRaw('x'`, the narrator's `emit('x'`)
 *     and the heartbeat's `ping`. The turn is chatStream.js and the modules
 *     it was split into (turnSetup, buildLoop, toolDispatch, turnClosing, …),
 *     so the writers are chatStream.js plus every `require('./x')` it reaches
 *     inside that folder;
 *   - the WEB: every `case 'x'` of agent-hub/src/hooks/automationBuilder/
 *     reducer.ts, the switch useAutomationBuilderStream.ts hands each event to.
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

/**
 * The files that write onto POST /builder/stream: the route's chatStream.js
 * and, transitively, every sibling module it requires.
 */
function streamWriters(): string[] {
    const seen = new Set<string>();
    const todo = ['chatStream.js'];
    while (todo.length) {
        const file = todo.pop() as string;
        if (seen.has(file)) continue;
        seen.add(file);
        const source = fs.readFileSync(path.join(BUILDER, file), 'utf8');
        for (const m of source.matchAll(/require\('\.\/([A-Za-z]+)'\)/g)) todo.push(`${m[1] as string}.js`);
    }
    return [...seen];
}

function serverEvents(): string[] {
    const source = streamWriters().map((f) => fs.readFileSync(path.join(BUILDER, f), 'utf8')).join('\n');
    const names = [...source.matchAll(/\b(?:send|sendRaw|emit)\(\s*'([a-z_]+)'/g)].map((m) => m[1] as string);
    return [...new Set([...names, 'ping'])].sort();
}

const WEB_HOOK = path.join(REPO, 'agent-hub/src/hooks/useAutomationBuilderStream.ts');
const WEB_REDUCER = path.join(REPO, 'agent-hub/src/hooks/automationBuilder/reducer.ts');

function webEvents(): string[] {
    const source = fs.readFileSync(WEB_REDUCER, 'utf8');
    return [...new Set([...source.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1] as string))].sort();
}

const adapter = builderFrames(() => ({}));

describe('the builder stream vocabulary', () => {
    it('reads enough of both sides for the check to mean something', () => {
        expect(serverEvents().length).toBeGreaterThan(20);
        expect(webEvents().length).toBeGreaterThan(20);
        expect(serverEvents()).toEqual(expect.arrayContaining(['draft', 'validation_errors', 'tool_call', 'plan', 'dryrun', 'finalized', 'done', 'error']));
    });

    it('reads the writers the old list named, and the switch the hook still dispatches to', () => {
        expect(streamWriters()).toEqual(expect.arrayContaining(['chatStream.js', 'modelStream.js', 'thoughtNarrator.js', 'layerDelegation.js']));
        const hook = fs.readFileSync(WEB_HOOK, 'utf8');
        expect(hook).toContain("import { handle } from './automationBuilder/reducer';");
        expect(hook).toContain('handle(setState, currentEvent, data);');
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
