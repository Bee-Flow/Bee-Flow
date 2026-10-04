import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { authFetch } from '../../../utils/helpers';
import { parsePattern, parseScanSources, parseSuggestions, repeatingApi } from './repeating';

const fetchMock = vi.mocked(authFetch);
const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)),
    headers: new Headers(),
}) as unknown as Response;
const sse = (frames: string[]) => {
    const enc = new TextEncoder();
    let i = 0;
    return {
        ok: true, status: 200, headers: new Headers(),
        body: new ReadableStream({ pull(c) { if (i < frames.length) c.enqueue(enc.encode(frames[i++])); else c.close(); } }),
    } as unknown as Response;
};

afterEach(() => fetchMock.mockReset());

describe('parsing', () => {
    it('reads the source groups, tolerating junk rows', () => {
        const parsed = parseScanSources({
            windowDays: 60,
            groups: [
                { id: 'mail', kind: 'live', apps: [{ id: 'gmail', label: 'Gmail', connected: true }, { label: 'no id' }] },
                { kind: 'stored' },
                { id: 'beeflow', kind: 'whatever', connected: true, apps: [] },
            ],
        });
        expect(parsed.windowDays).toBe(60);
        expect(parsed.groups).toEqual([
            { id: 'mail', kind: 'live', apps: [{ id: 'gmail', label: 'Gmail', connected: true }], connected: true },
            { id: 'beeflow', kind: 'stored', apps: [], connected: true },
        ]);
        expect(parseScanSources(null)).toEqual({ windowDays: 90, groups: [] });
    });

    it('normalises a pattern and drops what is not a number', () => {
        const p = parsePattern({ signature: 's', cadence: { kind: 'weekly', hourBand: [9, 10], weekday: 1 }, occurrences: 'x', weekdayHistogram: [1, 2], minutesPerMonth: [5, 10, 15] });
        expect(p).toMatchObject({ signature: 's', occurrences: 0, weekdayHistogram: [0, 0, 0, 0, 0, 0, 0], minutesPerMonth: null, confidence: 'normal', draft: null });
        expect(p?.cadence).toMatchObject({ kind: 'weekly', hourBand: [9, 10], weekday: 1 });
        expect(parsePattern('nope')).toBeNull();
    });

    it('keeps titled suggestions once each', () => {
        expect(parseSuggestions([{ id: 'a', title: 'A' }, { id: 'a', title: 'A again' }, { title: '' }, { title: 'No id' }]).map(s => s.id)).toEqual(['a', 's3']);
    });
});

describe('calls', () => {
    it('reads the last patterns scan, and nothing for 204 or an ideas scan', async () => {
        fetchMock.mockResolvedValueOnce(json({ suggestions: [{ id: 'a', title: 'A' }], scannedAt: '2026-10-01T00:00:00Z' }));
        expect((await repeatingApi.fetchLastScan())?.suggestions).toHaveLength(1);
        expect(String(fetchMock.mock.calls[0][0])).toBe('/api/automation/builder/suggest/last');
        fetchMock.mockResolvedValueOnce(json(null, 204));
        expect(await repeatingApi.fetchLastScan()).toBeNull();
        fetchMock.mockResolvedValueOnce(json({ suggestions: [], mode: 'ideas' }));
        expect(await repeatingApi.fetchLastScan()).toBeNull();
    });

    it('streams the scan frames in order', async () => {
        fetchMock.mockResolvedValueOnce(sse([
            'event: phase\ndata: {"phase":"collecting"}\n\n',
            'event: source_step\ndata: {"source":"mail","app":"gmail","status":"done","events":3}\n\n',
            'event: done\ndata: {"suggestions":[]}\n\n',
        ]));
        const events: string[] = [];
        await repeatingApi.streamPatternScan({ mode: 'patterns', sources: ['mail'] }, e => events.push(e));
        expect(events).toEqual(['phase', 'source_step', 'done']);
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({ mode: 'patterns', sources: ['mail'] });
    });

    it('throws a refused scan with its status and Retry-After', async () => {
        const res = { ...json({ error: 'Too many requests' }, 429), headers: new Headers({ 'Retry-After': '20' }) } as unknown as Response;
        fetchMock.mockResolvedValueOnce(res);
        await expect(repeatingApi.streamPatternScan({}, () => {})).rejects.toMatchObject({ status: 429, retryAfter: 20, message: 'Too many requests' });
    });

    it('throws when feedback is refused, so the page can bring the card back', async () => {
        fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 400));
        await expect(repeatingApi.postFeedback({ action: 'snoozed', suggestion: { title: 'A' } })).rejects.toThrow('nope');
    });
});
