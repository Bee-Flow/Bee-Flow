import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * De client van POST /api/studio/ai/route.
 *
 * Het punt dat elke test hier bewaakt: "de router koos niets" en "ik kon het
 * antwoord niet lezen" mogen NOOIT dezelfde vorm krijgen. Een mislukte fetch
 * is `ok: false`, nooit een geslaagd resultaat met `kind: null`.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: (...a) => fetchMock(...a) }));

import { routeDescription, ROUTE_ERROR_CODES } from './routeApi';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => (body === undefined ? {} : body) });

beforeEach(() => { fetchMock.mockReset(); });

describe('routeDescription — de vijf foutcodes', () => {
    it('vraagt niets aan de server voor een lege brief en antwoordt no_text', async () => {
        expect(await routeDescription('   ')).toEqual({ ok: false, code: 'no_text' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        [400, 'no_text'],
        [503, 'no_model'],
        [502, 'ai_unusable'],
        [429, 'rate_limited'],
        [500, 'failed'],
        [418, 'failed'],
    ])('status %i wordt code %s', async (status, code) => {
        fetchMock.mockResolvedValue(fail(status));
        expect(await routeDescription('een agent')).toEqual({ ok: false, code });
    });

    it('kent alleen deze vijf codes', () => {
        expect(ROUTE_ERROR_CODES).toEqual(['no_text', 'no_model', 'ai_unusable', 'rate_limited', 'failed']);
    });

    it('neemt de code uit de body over als de server hem meestuurt', async () => {
        fetchMock.mockResolvedValue(fail(500, { code: 'no_model' }));
        expect(await routeDescription('een agent')).toEqual({ ok: false, code: 'no_model' });
    });

    it('negeert een code die we niet kennen en valt terug op de status', async () => {
        fetchMock.mockResolvedValue(fail(429, { code: 'weird_new_thing' }));
        expect(await routeDescription('een agent')).toEqual({ ok: false, code: 'rate_limited' });
    });

    it('een foutantwoord zonder JSON blijft leesbaar via de status', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => { throw new Error('not json'); } });
        expect(await routeDescription('een agent')).toEqual({ ok: false, code: 'no_model' });
    });
});

describe('routeDescription — "kon niet lezen" is geen "geen soort"', () => {
    it('een omgevallen fetch is ok:false, niet kind:null', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));
        const res = await routeDescription('een agent');
        expect(res).toEqual({ ok: false, code: 'failed' });
        expect(res.ok).toBe(false);
        expect('kind' in res).toBe(false);
    });

    it('een 200 met een onleesbare body is ook ok:false', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('boom'); } });
        expect(await routeDescription('een agent')).toEqual({ ok: false, code: 'failed' });
    });

    it('een 200 met een soort die we niet kennen is ok:true zonder soort', async () => {
        fetchMock.mockResolvedValue(ok({ kind: 'spaceship', name: 'X' }));
        const res = await routeDescription('een agent');
        expect(res.ok).toBe(true);
        expect(res.kind).toBe(null);
    });

    it('"je mag niets bouwen" en "we konden het niet uitzoeken" blijven te onderscheiden', async () => {
        fetchMock.mockResolvedValue(ok({ kind: null, available: [], undecided: [] }));
        const leeg = await routeDescription('x');
        expect(leeg).toMatchObject({ ok: true, kind: null, available: [], undecided: [] });

        fetchMock.mockResolvedValue(ok({ kind: null, available: [], undecided: ['app', 'solution'] }));
        const onleesbaar = await routeDescription('x');
        expect(onleesbaar.available).toEqual([]);
        expect(onleesbaar.undecided).toEqual(['app', 'solution']);
    });

    it('afbreken is geen fout: de AbortError gaat door naar de aanroeper', async () => {
        const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
        fetchMock.mockRejectedValue(err);
        await expect(routeDescription('een agent')).rejects.toThrow('aborted');
    });
});

describe('routeDescription — normalisatie', () => {
    it('post de getrimde tekst naar het endpoint', async () => {
        fetchMock.mockResolvedValue(ok({ kind: 'agent' }));
        await routeDescription('  een agent  ');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/studio/ai/route');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ text: 'een agent' });
    });

    it('geeft het signal door zodat annuleren echt afbreekt', async () => {
        fetchMock.mockResolvedValue(ok({ kind: 'agent' }));
        const c = new AbortController();
        await routeDescription('een agent', { signal: c.signal });
        expect(fetchMock.mock.calls[0][1].signal).toBe(c.signal);
    });

    it('trimt naam en brief en houdt onbekende metgezellen buiten de deur', async () => {
        fetchMock.mockResolvedValue(ok({
            kind: 'agent',
            name: '  Offertehulp  ',
            seed: '  een agent die offertes beantwoordt ',
            companions: ['kb', { kind: 'kb', name: 'Offertes' }, { kind: 'unicorn' }, null, { kind: 'agent' }, 'datatable'],
            available: ['agent', 'kb', 'unicorn', 'agent'],
        }));
        const res = await routeDescription('x');
        expect(res.name).toBe('Offertehulp');
        expect(res.seed).toBe('een agent die offertes beantwoordt');
        // 'unicorn' gedropt, 'agent' is de hoofdsoort, 'kb' telt één keer.
        expect(res.companions).toEqual([{ kind: 'kb', name: '' }, { kind: 'datatable', name: '' }]);
        // De beschikbaarheidslijst wordt net zo hard geklemd als de soort zelf.
        expect(res.available).toEqual(['agent', 'kb']);
        expect(res.undecided).toEqual([]);
    });

    it('zegt de server niets over beschikbaarheid, dan is dat null en niet "mag alles"', async () => {
        fetchMock.mockResolvedValue(ok({ kind: 'agent' }));
        const res = await routeDescription('x');
        expect(res.available).toBe(null);
        expect(res.companions).toEqual([]);
        expect(res.name).toBe('');
    });

    it('een available die geen lijst is telt als onbekend, niet als "mag alles"', async () => {
        fetchMock.mockResolvedValue(ok({ kind: 'app', available: true }));
        expect((await routeDescription('x')).available).toBe(null);
    });

    it('companions dat geen lijst is levert een lege lijst, geen worp', async () => {
        fetchMock.mockResolvedValue(ok({ kind: 'agent', companions: 'kb' }));
        expect((await routeDescription('x')).companions).toEqual([]);
    });
});
