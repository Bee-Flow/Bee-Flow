// "Make a plan" over its stream: progress as it comes, then the plan or a sentence. The request is handed in, so
// the stream read here is one this test wrote: nothing is mocked.
import { describe, expect, it } from 'vitest';
import { makeCoworkPlan } from './coworkPlanMake';
import type { PlanMakeProgress } from './coworkPlan.types';

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A stream answer made of these frames, cut into chunks at awkward places. */
function streamOf(...frames: string[]): Response {
    const all = new TextEncoder().encode(frames.join(''));
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let at = 0; at < all.length; at += 37) controller.enqueue(all.slice(at, at + 37));
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const STATE = { automationId: 'auto-new', draft: null, approved: null, widens: [], upToDate: false };
const signal = () => new AbortController().signal;

describe('makeCoworkPlan', () => {
    it('passes on what is being drafted and ends with the plan and what the planner said about it', async () => {
        const seen: PlanMakeProgress[] = [];
        const asked: string[] = [];
        const outcome = await makeCoworkPlan('cw-1', { signal: signal(), onProgress: (p) => seen.push(p) }, async (id) => {
            asked.push(id);
            return streamOf(
                frame('progress', { phase: 'thinking', round: 0 }),
                ': ping\n\n',
                frame('progress', { phase: 'drafted', round: 1, steps: [{ id: 'a', title: 'Get the mail', kind: 'fixed' }] }),
                frame('progress', { phase: 'saving' }),
                frame('done', { summary: 'It reads the mail and tells you.', state: STATE }),
            );
        });
        expect(asked).toEqual(['cw-1']);
        expect(seen.map((p) => p.phase)).toEqual(['thinking', 'drafted', 'saving']);
        expect(outcome).toEqual({ state: STATE, summary: 'It reads the mail and tells you.', error: null });
    });

    it('a refusal is an ordinary answer: its sentence is the error, and nothing was drafted', async () => {
        const refused = new Response(JSON.stringify({ error: 'This item already has a plan. Take it off to make a new one.', code: 'cowork_plan_refused' }), { status: 409 });
        expect(await makeCoworkPlan('cw-1', { signal: signal() }, async () => refused)).toEqual({
            state: null, summary: '', error: 'This item already has a plan. Take it off to make a new one.',
        });
        const bare = new Response('gateway', { status: 502 });
        expect((await makeCoworkPlan('cw-1', { signal: signal() }, async () => bare)).error).toBe('HTTP 502');
    });

    it('a making that failed ends with the sentence the server gave', async () => {
        const outcome = await makeCoworkPlan('cw-1', { signal: signal() }, async () => streamOf(
            frame('progress', { phase: 'thinking', round: 0 }),
            frame('error', { error: 'No plan could be made for this brief.', code: 'cowork_planner_empty' }),
        ));
        expect(outcome).toEqual({ state: null, summary: '', error: 'No plan could be made for this brief.' });
    });

    it('a stream that ends without a plan and without a reason is a failure, not a plan', async () => {
        const outcome = await makeCoworkPlan('cw-1', { signal: signal() }, async () => streamOf(frame('progress', { phase: 'thinking', round: 0 })));
        expect(outcome.state).toBeNull();
        expect(outcome.error).toBe('');
    });

    it('a stop by the caller ends it as a stop', async () => {
        const stop = new AbortController();
        const making = makeCoworkPlan('cw-1', { signal: stop.signal, onProgress: () => stop.abort() }, async () => streamOf(
            frame('progress', { phase: 'thinking', round: 0 }),
            frame('done', { summary: 'x', state: STATE }),
        ));
        await expect(making).rejects.toMatchObject({ name: 'AbortError' });
    });
});
