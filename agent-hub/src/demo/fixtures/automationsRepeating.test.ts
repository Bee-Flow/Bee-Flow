/**
 * The "Find repeating work" demo answers in the server's shapes: the page's
 * own parsers read every route, the cards carry only masked templates, a
 * hidden pattern stays hidden on the next read, and "Scan again" replays a
 * stream the shared SSE reader can follow to its `done`.
 *
 * Run: cd agent-hub && npx vitest run src/demo/fixtures/automationsRepeating.test.ts
 */
import { describe, it, expect } from 'vitest';
import { createDemoTransport } from '../demoTransport';
import { COMMON_ROUTES } from './common';
import * as automations from './automations';
import { parseScanResult, parseScanSources } from '../../api/queries/automation/repeating';
import { readEventStream } from '../../utils/sseStream';

type Json = Record<string, any>;
const BASE = '/api/automation/builder';

function demo() {
    const state = automations.createState();
    const fetch = createDemoTransport({ ...COMMON_ROUTES, ...automations.ROUTES }, state) as (url: string, init?: Json) => Promise<Response>;
    const post = (url: string, body: Json) => fetch(url, { method: 'POST', body: JSON.stringify(body) });
    return { fetch, post };
}

describe('automations demo: find repeating work', () => {
    it('lists the source groups, with Gmail and Bee Flow activity connected', async () => {
        const res = await demo().fetch(`${BASE}/suggest/sources`);
        const sources = parseScanSources(await res.json());
        expect(sources.windowDays).toBe(90);
        expect(sources.groups.map(g => g.id)).toEqual(['mail', 'calendar', 'files', 'beeflow']);
        expect(sources.groups.filter(g => g.connected).map(g => g.id)).toEqual(['mail', 'beeflow']);
    });

    it('serves a last scan the page reads as three measured patterns', async () => {
        const res = await demo().fetch(`${BASE}/suggest/last?mode=patterns`);
        const scan = parseScanResult(await res.json());
        expect(scan?.mode).toBe('patterns');
        expect(scan?.sources).toEqual(['mail', 'beeflow']);
        expect(scan?.suggestions).toHaveLength(3);
        for (const s of scan?.suggestions ?? []) {
            expect(s.groundedIn).toBe('activity');
            const p = s.pattern!;
            expect(p.signature).toMatch(/^[0-9a-f]{32}$/);
            expect(p.weekdayHistogram).toHaveLength(7);
            const [lo, hi] = p.minutesPerMonth!;
            expect(lo).toBeLessThan(hi);
            expect(p.draft!.steps.length).toBeGreaterThan(0);
        }
    });

    it('never carries an address, a link or a real domain', async () => {
        const text = await (await demo().fetch(`${BASE}/suggest/last`)).text();
        expect(text).not.toMatch(/@|https?:\/\/|\b[a-z0-9-]+\.(com|nl|org|net|io)\b/i);
    });

    it('has no last scan for ideas mode', async () => {
        const res = await demo().fetch(`${BASE}/suggest/last?mode=ideas`);
        expect(res.status).toBe(204);
    });

    it('keeps a snoozed pattern hidden on the next read, like the server', async () => {
        const d = demo();
        const first = parseScanResult(await (await d.fetch(`${BASE}/suggest/last`)).json());
        const target = first!.suggestions[1];
        const ok = await d.post(`${BASE}/feedback`, { action: 'snoozed', signature: target.pattern!.signature, suggestion: { title: target.title } });
        expect(ok.status).toBe(200);
        const next = parseScanResult(await (await d.fetch(`${BASE}/suggest/last`)).json());
        expect(next!.suggestions.map(s => s.id)).not.toContain(target.id);
        expect(next!.suggestions).toHaveLength(2);
    });

    it('replays a scan as a stream that ends in done', async () => {
        const res = await demo().post(`${BASE}/suggest`, { mode: 'patterns', sources: ['mail', 'beeflow'], focus: '', force: true });
        const events: string[] = [];
        let done: Json | null = null;
        await readEventStream(res.body!, (event: string, data: Json) => {
            events.push(event);
            if (event === 'done') done = data;
        });
        expect(events[0]).toBe('model');
        expect(events).toContain('source_step');
        expect(events.filter(e => e === 'suggestion')).toHaveLength(3);
        expect(parseScanResult(done)?.suggestions).toHaveLength(3);
    });
});
