// @typecheck
/**
 * The outside world of the Fireflies engine tests (the planner's try-outs, usecases/coworkPlanner.tryOut.engine.pg.test.js;
 * the automatic fix of the wiring, ./repairs/autoResolve.wiring.engine.pg.test.js), stood in for through the product's
 * own seams:
 *
 *   - Fireflies: the dispatcher answers the two tools in the real tools' shape (integrations/firefliesTools.js) with a
 *     MARKER planted in every meeting title, and records every call; a summary asked for an id that is not a meeting
 *     fails with an error that QUOTES what it was given (as an app error can), so a test sees that such text goes
 *     nowhere;
 *   - the model: an OpenAI-compatible server on localhost configured as the instance's provider, which answers every
 *     AI step with one fixed sentence and records what it was asked.
 *
 * Call `firefliesWorld()` once at the top of a test file, after the stores are on PGlite.
 */

'use strict';

const { before, after } = require('node:test');
const http = require('node:http');

const MARKER = 'MARKER-fireflies-7c1d';
const TOOLS = ['fireflies_list_transcripts', 'fireflies_get_summary'];
const ANSWER = 'Overview written for the owner.';

function firefliesWorld() {
    const world = {
        MARKER,
        TOOLS,
        /** @type {Array<{ id: string, title: string, date: string, participants: string[] }>} */
        meetings: [1, 2].map((n) => ({ id: `t${n}`, title: `${MARKER} weekly ${n}`, date: '2026-11-17', participants: [`p${n}@example.com`] })),
        /** @type {Array<{ tool: string, inputs: Record<string, unknown> }>} */
        calls: [],
        /** @type {unknown[]} */
        modelRequests: [],
    };
    const toolDispatcher = require('../tools/toolDispatcher');
    const integrationTools = require('../integrations/integrationTools');
    const original = { executeTool: toolDispatcher.executeTool, getIntegrationTools: integrationTools.getIntegrationTools };
    /** @type {http.Server | null} */
    let server = null;

    before(async () => {
        toolDispatcher.executeTool = async (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ inputs) => {
            world.calls.push({ tool, inputs });
            if (tool === 'fireflies_list_transcripts') return { results: world.meetings, count: world.meetings.length, message: `Found ${world.meetings.length} transcript(s).` };
            const meeting = world.meetings.find((m) => m.id === inputs?.transcriptId);
            if (!meeting) throw new Error(`Fireflies has no transcript "${inputs?.transcriptId}"`);
            return { id: meeting.id, title: meeting.title, summary: { overview: `${MARKER} overview of ${meeting.id}` } };
        };
        integrationTools.getIntegrationTools = async () => (/** @type {Awaited<ReturnType<typeof original.getIntegrationTools>>} */ (/** @type {unknown} */ ({ tools: TOOLS.map((name) => ({ type: 'function', function: { name } })) })));

        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                res.setHeader('content-type', 'application/json');
                if (req.method === 'GET') return res.end(JSON.stringify(req.url?.endsWith('/models') ? { data: [{ id: 'steady', object: 'model' }] } : { models: [] }));
                world.modelRequests.push(raw ? JSON.parse(raw) : {});
                res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'steady', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
            });
        });
        await new Promise((resolve) => { /** @type {http.Server} */ (server).listen(0, '127.0.0.1', () => resolve(null)); });
        const port = /** @type {import('node:net').AddressInfo} */ (/** @type {http.Server} */ (server).address()).port;
        await require('../../stores/configStore').setConfig('ai', { providers: [{ id: 'local', name: 'Local', type: 'ollama', url: `http://127.0.0.1:${port}/v1`, model: 'steady', apiKey: 'none' }], defaultProviderId: 'local' });
    });

    after(async () => {
        toolDispatcher.executeTool = original.executeTool;
        integrationTools.getIntegrationTools = original.getIntegrationTools;
        await new Promise((resolve) => { server?.close(() => resolve(null)); });
    });

    return world;
}

module.exports = { firefliesWorld, MARKER, ANSWER };
