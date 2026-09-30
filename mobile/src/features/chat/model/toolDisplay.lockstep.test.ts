/**
 * DIFFERENTIAL lockstep: the activity rows against the web's
 * chatToolCallDisplay.js, getToolLabel and TOOL_NAME_MAP (utils/helpers.js)
 * and formatDurationMs (timelineParts.jsx), on the same calls.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC, loadWebFunctions, loadWebModule } from '@/shared/testing/webModule';

import { describeTool, detailOf, errorOf, formatDurationMs, TOOL_NAME_MAP, toolLabel, toolPayload, visibleTools } from './toolDisplay';
import type { ToolActivity } from './types';

/**
 * helpers.js as a whole cannot run here (it reads `import.meta`), so the two
 * declarations are cut out of it as text — the map and the function, verbatim —
 * and evaluated together.
 */
function loadToolLabels(): { TOOL_NAME_MAP: Record<string, string>; getToolLabel: (n?: string) => string } {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/utils/helpers.js`, 'utf8');
    const cut = (start: string) => {
        const at = src.indexOf(start);
        if (at < 0) throw new Error(`${start} not found`);
        return src.slice(at, src.indexOf('\n};', at) + 3).replace(/^export /, '');
    };
    const body = `${cut('export const TOOL_NAME_MAP = {')}\n${cut('export const getToolLabel = ')}\nreturn { TOOL_NAME_MAP, getToolLabel };`;
    return new Function(body)();
}

const helpers = loadToolLabels();
const web = loadWebModule<{
    detailOf: (a: unknown) => string;
    errorOf: (r: unknown, p?: unknown) => string | null;
    describeChatTool: (e: unknown, ctx: unknown) => { title: string; detail: string; status: string; error: string | null; durationMs: number | null };
    detailPayload: (e: unknown, r: unknown) => { args: unknown; result: unknown };
    visibleToolHistory: (m: unknown) => unknown[];
}>('components/chat/MessageItem/chatToolCallDisplay.js', { getToolLabel: helpers.getToolLabel });
const timeline = loadWebFunctions<{ formatDurationMs: (ms: unknown) => string | null }>(
    'components/chat/MessageItem/timelineParts.jsx',
    ['formatDurationMs'],
);

const CALLS: ToolActivity[] = [
    { id: '1', name: 'serper_search', status: 'done', args: { query: '  bees   and honey ', limit: 10 }, startTime: 1000, endTime: 2750, result: 'ok' },
    { id: '2', name: 'web_fetch_page', status: 'done', args: { _internal: 'x', url: 'https://example.com' }, resultPreview: '[Tool blocked — PII guard unavailable (fail-closed)]' },
    { id: '3', name: 'gmail_send', status: 'done', args: { body: 'x'.repeat(200) }, result: { error: 'Not connected' } },
    { id: '4', name: 'kb', status: 'running', args: {} },
    { id: '5', name: 'calc', status: 'done', result: { ok: false, reason: 'div by zero' } },
    { id: '6', name: 'x', status: 'done', resultPreview: '{"error":"boom","x":1}' },
    { id: '7', name: 'sequentialthinking', status: 'done' },
];

/** The same call as a web toolHistory row, with its full result beside it. */
const webEntry = (c: ToolActivity) => ({ name: c.name, args: c.args, status: c.status, startTime: c.startTime, endTime: c.endTime, resultPreview: c.resultPreview });

describe('the tool rows match the web', () => {
    it('labels every tool the same, mapped or not', () => {
        expect(TOOL_NAME_MAP).toEqual(helpers.TOOL_NAME_MAP);
        for (const name of [...Object.keys(TOOL_NAME_MAP), 'create_calendar_event', 'x', '', undefined]) {
            expect(toolLabel(name)).toBe(helpers.getToolLabel(name));
        }
    });

    it('hides the narrated tool', () => {
        expect(visibleTools(CALLS).map((c) => c.name)).toEqual(
            (web.visibleToolHistory({ toolHistory: CALLS.map(webEntry) }) as { name: string }[]).map((c) => c.name),
        );
    });

    it.each(CALLS.map((c) => [c.name, c] as const))('%s', (_name, call) => {
        for (const streaming of [true, false]) {
            expect(describeTool(call, { streaming })).toEqual(web.describeChatTool(webEntry(call), { result: call.result ?? null, streaming }));
        }
        expect(detailOf(call.args)).toBe(web.detailOf(call.args));
        expect(errorOf(call.result ?? null, call.resultPreview)).toBe(web.errorOf(call.result ?? null, call.resultPreview));
        const theirs = web.detailPayload(webEntry(call), call.result ?? null);
        const mine = toolPayload(call);
        expect(mine.result === null).toBe(theirs.result == null);
    });

    it('formats durations the same', () => {
        for (const ms of [0, 840, 999.6, 1000, 1750, 61234, -3, NaN, undefined]) {
            expect(formatDurationMs(ms as number)).toBe(timeline.formatDurationMs(ms));
        }
    });
});
