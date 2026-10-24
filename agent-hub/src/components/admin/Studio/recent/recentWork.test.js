// Unit tests for "Recently edited" (recentWork.js).
//
// Two halves, just like attentionChecks.test.js:
//   - the PURE reader and merger, fed with exactly the payload that the
//     endpoint of that section returns;
//   - the runner, through a stubbed authFetch, so the three answers
//     (read / refused / fell over) take the same path the screen takes.
//
// The rules this file must keep honest:
//   1. "nothing found" and "could not look" are two verdicts;
//   2. a kind that reports no status gets none invented;
//   3. a 403 is not yours and therefore not a gap — a 500 is.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => fetchMock(...args),
}));

import {
    RECENT_LIMIT, STATUS_LABELS,
    evaluateRecentSection, mergeRecentEntries, recentSourcesFor, runRecentSection,
    runRecentWork, statusLabel, statuslessKinds, timeOf,
} from './recentWork';
import { RECENT_STATUS, STUDIO_RECENT_SOURCES } from '../../../../utils/studioRecentSources';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

/** A section as studioNavSections yields it (only what this model reads). */
const section = (id, over = {}) => ({
    id, urlSegment: id, kind: null, locked: null, ...over,
});

const AI_TASKS = { sectionId: 'aiTasks', kind: 'automation', urlSegment: 'automations', url: '/api/automation' };
const KNOWLEDGE = { sectionId: 'knowledge', kind: 'kb', urlSegment: 'knowledge', url: '/api/kb' };

beforeEach(() => {
    fetchMock.mockReset();
});

/* ── De bronkeuze ─────────────────────────────────────────────────────────── */

describe('recentSourcesFor', () => {
    it('vraagt alleen secties die een lijst hebben én open zijn', () => {
        const { asked, skipped } = recentSourcesFor([
            section('aiTasks', { urlSegment: 'automations', kind: 'automation' }),
            section('skills', { kind: 'skill' }),
            // Locked: a sign, not a door — nothing to read, and no gap.
            section('apps', { kind: 'app', locked: 'ceiling' }),
            // No source in the register: Forms and Runs deliberately have none.
            section('forms', { kind: 'form' }),
            section('runs'),
        ]);
        expect(asked.map((a) => a.sectionId)).toEqual(['aiTasks', 'skills']);
        expect(asked[0]).toMatchObject({ url: '/api/automation', urlSegment: 'automations', kind: 'automation' });
        expect(skipped).toEqual(['apps']);
    });

    it('slaat een descriptor zonder segment over — die kan nergens heen', () => {
        const { asked } = recentSourcesFor([{ id: 'skills', urlSegment: null }]);
        expect(asked).toEqual([]);
    });

    it('verdraagt rommel zonder te gooien', () => {
        expect(recentSourcesFor(null)).toEqual({ asked: [], skipped: [], unsupported: [] });
        expect(recentSourcesFor([null, undefined, {}]).asked).toEqual([]);
    });
});

/* ── De pure evaluator ────────────────────────────────────────────────────── */

describe('evaluateRecentSection', () => {
    it('leest de envelope van de sectie en hangt kind, pad en status aan elke rij', () => {
        const { entries, whole } = evaluateRecentSection(AI_TASKS, {
            automations: [
                { id: 'r1', title: 'Offerte', description: 'Maakt offertes', updatedAt: '2026-09-01T10:00:00Z', isDraft: false, isActive: true, lastStatus: 'success' },
            ],
        });
        expect(whole).toBe(true);
        expect(entries).toEqual([{
            key: 'aiTasks:r1',
            id: 'r1',
            sectionId: 'aiTasks',
            kind: 'automation',
            name: 'Offerte',
            description: 'Maakt offertes',
            updatedAt: '2026-09-01T10:00:00Z',
            at: Date.parse('2026-09-01T10:00:00Z'),
            status: RECENT_STATUS.ACTIVE,
            path: 'studio/automations/r1',
        }]);
    });

    it('een soort zonder status krijgt UNSUPPORTED, geen stilzwijgend "in orde"', () => {
        const { entries } = evaluateRecentSection(KNOWLEDGE, [
            { id: 'k1', name: 'Handboek', updated_at: '2026-09-01T10:00:00Z', document_count: 0 },
        ]);
        expect(entries[0].status).toBe(RECENT_STATUS.UNSUPPORTED);
    });

    it('houdt de RUWE rij bij de genormaliseerde rij, ook als er rijen wegvallen', () => {
        // The first row has no id and disappears in the mapper. A link by index would stick the status of the dropped row onto the second one.
        const { entries } = evaluateRecentSection(AI_TASKS, {
            automations: [
                { title: 'geen id', isDraft: true },
                { id: 'r2', title: 'Wel een id', updatedAt: '2026-09-01T10:00:00Z', isDraft: false, isActive: false },
            ],
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ id: 'r2', status: RECENT_STATUS.PAUSED });
    });

    it('een id met een schuine streep wordt gecodeerd, nooit rauw in het pad', () => {
        const { entries } = evaluateRecentSection(KNOWLEDGE, [{ id: 'a/b', name: 'x' }]);
        expect(entries[0].path).toBe('studio/knowledge/a%2Fb');
    });

    it('een body die geen lijst is, is GEEN lege sectie maar een gat', () => {
        // The envelope is missing (`{ }` instead of `{ automations: [] }`): that is an answer this client cannot read.
        expect(evaluateRecentSection(AI_TASKS, {})).toEqual({ entries: [], whole: false });
        expect(evaluateRecentSection(AI_TASKS, null)).toEqual({ entries: [], whole: false });
        // Een ECHT lege lijst is wél heel: niets gevonden, en dat weten we.
        expect(evaluateRecentSection(AI_TASKS, { automations: [] })).toEqual({ entries: [], whole: true });
    });

    it('een onbekende sectie levert een gat, geen throw', () => {
        expect(evaluateRecentSection({ sectionId: 'nope', urlSegment: 'nope' }, [])).toEqual({ entries: [], whole: false });
    });
});

/* ── Samenvoegen ──────────────────────────────────────────────────────────── */

describe('mergeRecentEntries', () => {
    const at = (key, iso) => ({ key, at: iso === null ? null : Date.parse(iso), updatedAt: iso });

    it('nieuwste eerst, over de secties heen', () => {
        const merged = mergeRecentEntries([
            [at('a:1', '2026-09-01T10:00:00Z')],
            [at('b:1', '2026-09-03T10:00:00Z'), at('b:2', '2026-09-02T10:00:00Z')],
        ]);
        expect(merged.map((m) => m.key)).toEqual(['b:1', 'b:2', 'a:1']);
    });

    it('rijen zonder leesbare tijd staan achteraan, maar vallen niet weg', () => {
        const merged = mergeRecentEntries([[at('a:1', null), at('b:1', '2026-09-01T10:00:00Z')]]);
        expect(merged.map((m) => m.key)).toEqual(['b:1', 'a:1']);
    });

    it('een gelijke tijd geeft een vaste volgorde — geen geschuif tussen renders', () => {
        const one = mergeRecentEntries([[at('b:1', '2026-09-01T10:00:00Z'), at('a:1', '2026-09-01T10:00:00Z')]]);
        const two = mergeRecentEntries([[at('a:1', '2026-09-01T10:00:00Z'), at('b:1', '2026-09-01T10:00:00Z')]]);
        expect(one.map((m) => m.key)).toEqual(two.map((m) => m.key));
    });

    it('kapt af op de limiet', () => {
        const many = Array.from({ length: 20 }, (_, i) => at(`a:${i}`, `2026-09-0${(i % 9) + 1}T10:00:00Z`));
        expect(mergeRecentEntries([many])).toHaveLength(RECENT_LIMIT);
        expect(mergeRecentEntries([many], 3)).toHaveLength(3);
        expect(mergeRecentEntries([many], 0)).toHaveLength(0);
    });

    it('verdraagt lege en kapotte invoer', () => {
        expect(mergeRecentEntries(null)).toEqual([]);
        expect(mergeRecentEntries([null, [null], []])).toEqual([]);
    });
});

describe('timeOf', () => {
    it('leest een tijdstempel, en noemt onleesbaar onleesbaar', () => {
        expect(timeOf('2026-09-01T10:00:00Z')).toBe(Date.parse('2026-09-01T10:00:00Z'));
        expect(timeOf('gisteren')).toBeNull();
        expect(timeOf(null)).toBeNull();
        expect(timeOf('')).toBeNull();
    });
});

/* ── De runner ────────────────────────────────────────────────────────────── */

describe('runRecentSection', () => {
    it('gelezen: de rijen die erin zaten, geen gat', async () => {
        fetchMock.mockResolvedValue(ok([{ id: 'k1', name: 'Handboek', updated_at: '2026-09-01T10:00:00Z' }]));
        const result = await runRecentSection(KNOWLEDGE);
        expect(fetchMock).toHaveBeenCalledWith('/api/kb');
        expect(result).toMatchObject({ sectionId: 'knowledge', refused: false, gap: false });
        expect(result.entries).toHaveLength(1);
    });

    it('403: niet van jou — geen rijen en GEEN gat', async () => {
        fetchMock.mockResolvedValue(fail(403));
        expect(await runRecentSection(KNOWLEDGE)).toEqual({
            sectionId: 'knowledge', entries: [], refused: true, gap: false,
        });
    });

    it('401 en 500: niet kunnen kijken — een gat', async () => {
        for (const status of [401, 500, 503]) {
            fetchMock.mockResolvedValue(fail(status));
            expect(await runRecentSection(KNOWLEDGE), `status ${status}`).toEqual({
                sectionId: 'knowledge', entries: [], refused: false, gap: true,
            });
        }
    });

    it('een netwerkfout gooit niet door', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));
        expect(await runRecentSection(KNOWLEDGE)).toMatchObject({ gap: true, refused: false });
    });
});

describe('runRecentWork', () => {
    const twoSections = [
        section('aiTasks', { urlSegment: 'automations', kind: 'automation' }),
        section('knowledge', { kind: 'kb' }),
    ];
    const answer = (byUrl) => fetchMock.mockImplementation(async (url) => byUrl[url] || fail(404));

    it('voegt de secties samen en zegt dat het compleet is', async () => {
        answer({
            '/api/automation': ok({ automations: [{ id: 'r1', title: 'Offerte', updatedAt: '2026-09-03T10:00:00Z', isDraft: true }] }),
            '/api/kb': ok([{ id: 'k1', name: 'Handboek', updated_at: '2026-09-04T10:00:00Z' }]),
        });
        const result = await runRecentWork(twoSections);
        expect(result.items.map((i) => i.key)).toEqual(['knowledge:k1', 'aiTasks:r1']);
        expect(result).toMatchObject({ unavailable: [], skipped: [], complete: true });
    });

    it('één omgevallen lijst laat de andere staan en noemt zichzelf', async () => {
        answer({
            '/api/automation': fail(500),
            '/api/kb': ok([{ id: 'k1', name: 'Handboek', updated_at: '2026-09-04T10:00:00Z' }]),
        });
        const result = await runRecentWork(twoSections);
        expect(result.items.map((i) => i.key)).toEqual(['knowledge:k1']);
        expect(result.unavailable).toEqual(['aiTasks']);
        // There is work on the list, and yet it is not complete: that difference is exactly what the screen must be able to say.
        expect(result.complete).toBe(false);
    });

    it('een geweigerde en een gelockte sectie zijn skipped, niet incompleet', async () => {
        answer({
            '/api/automation': fail(403),
            '/api/kb': ok([]),
        });
        const result = await runRecentWork([...twoSections, section('apps', { kind: 'app', locked: 'ceiling' })]);
        expect(result.skipped).toEqual(['aiTasks', 'apps']);
        expect(result.unavailable).toEqual([]);
        // Empty AND complete: here "nothing edited yet" may appear on the screen.
        expect(result.complete).toBe(true);
        expect(result.items).toEqual([]);
    });

    it('vraagt een gelockte sectie niet eens', async () => {
        answer({ '/api/kb': ok([]) });
        await runRecentWork([section('knowledge', { kind: 'kb' }), section('apps', { kind: 'app', locked: 'ceiling' })]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('/api/kb');
    });

    it('zonder secties vraagt hij niets en belooft hij niets meer dan leeg', async () => {
        const result = await runRecentWork([]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result).toEqual({ items: [], unavailable: [], skipped: [], unsupported: [], complete: true });
    });
});

/* ── Statuswoorden ────────────────────────────────────────────────────────── */

describe('STATUS_LABELS', () => {
    it('elke code uit het register heeft een woord — ook de twee niet-statussen', () => {
        for (const code of Object.values(RECENT_STATUS)) {
            expect(STATUS_LABELS[code], code).toBeTruthy();
            expect(typeof STATUS_LABELS[code].key, `${code}.key`).toBe('string');
            expect(typeof STATUS_LABELS[code].fallback, `${code}.fallback`).toBe('string');
        }
    });

    it('precies vier secties melden geen status — de drift-wacht', () => {
        // These four supply the sentence under the list ("some kinds report no status here"). If one of them gets a status after all, that sentence must change with it; if one loses its own, a word silently disappears from a row. Tables came in: their `isPublished` is an AUDIENCE, not a lifecycle, and "Draft" on a table that is used daily is an invented word.
        const zonder = Object.entries(STUDIO_RECENT_SOURCES)
            .filter(([, source]) => typeof source.status !== 'function')
            .map(([id]) => id)
            .sort();
        expect(zonder).toEqual(['datatables', 'knowledge', 'skills', 'solutions']);
    });

    it('een onbekende code valt terug op "status onbekend", nooit op niets', () => {
        expect(statusLabel('iets-nieuws')).toBe(STATUS_LABELS[RECENT_STATUS.UNKNOWN]);
        expect(statusLabel(undefined)).toBe(STATUS_LABELS[RECENT_STATUS.UNKNOWN]);
    });

    it('"geen status" en "status onbekend" dragen allebei een uitleg', () => {
        for (const code of [RECENT_STATUS.UNSUPPORTED, RECENT_STATUS.UNKNOWN]) {
            expect(STATUS_LABELS[code].hintFallback, code).toBeTruthy();
        }
    });

    it('geen enkele niet-status draagt een geruststellende kleur', () => {
        for (const code of [RECENT_STATUS.UNSUPPORTED, RECENT_STATUS.UNKNOWN]) {
            expect(STATUS_LABELS[code].tone, code).toBe('var(--text-tertiary)');
        }
    });
});

describe('statuslessKinds', () => {
    it('noemt de soorten op de lijst die geen status melden, in schermvolgorde', () => {
        expect(statuslessKinds([
            { kind: 'automation', status: RECENT_STATUS.ACTIVE },
            { kind: 'kb', status: RECENT_STATUS.UNSUPPORTED },
            { kind: 'skill', status: RECENT_STATUS.UNSUPPORTED },
            { kind: 'kb', status: RECENT_STATUS.UNSUPPORTED },
            // "unknown" is something other than "reports none" and does not belong here.
            { kind: 'agent', status: RECENT_STATUS.UNKNOWN },
        ])).toEqual(['kb', 'skill']);
    });

    it('valt terug op de sectie als de soort ontbreekt, en verdraagt rommel', () => {
        expect(statuslessKinds([{ sectionId: 'solutions', status: RECENT_STATUS.UNSUPPORTED }])).toEqual(['solutions']);
        expect(statuslessKinds(null)).toEqual([]);
        expect(statuslessKinds([null])).toEqual([]);
    });
});

/* ── The gates themselves, and what this build cannot read ────────────────────── */

describe('runRecentWork — twee stiltes die geen stilte mogen zijn', () => {
    it('zonder antwoord op de poorten is er geen recht op "nog niets bewerkt"', async () => {
        // resolveStudioNav leaves a gated section out ENTIRELY for as long as the entitlements are loading or have fallen away, so those sections are not in `sections` and cannot be missed here. Without this flag the result is: seven lists never asked for, and "Nothing edited yet" with complete: true laid over them.
        const result = await runRecentWork([], { gatesResolved: false });
        expect(result.complete).toBe(false);
        expect(result.unavailable).toContain('gates');
    });

    it('met een echt poortantwoord blijft een lege lijst gewoon leeg', async () => {
        const result = await runRecentWork([], { gatesResolved: true });
        expect(result.complete).toBe(true);
        expect(result.unavailable).toEqual([]);
    });

    it('een runtime-module zonder bron valt niet stil weg maar wordt genoemd', async () => {
        // It IS in `sections` (StudioStart adds runtimeStudioApps) but has no endpoint contract this list can read. Staying silent would give someone who only works in it "Nothing edited yet".
        const remote = { id: 'security', urlSegment: 'security', label: () => 'Security', kind: null };
        const result = await runRecentWork([remote]);
        expect(result.unsupported).toEqual(['security']);
        expect(result.complete).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('een INGEBOUWDE sectie zonder bron blijft bewust stil', async () => {
        // Forms and Runs deliberately have none: a form IS an automation, and a run is an event. That is not a gap.
        const result = await runRecentWork([{ id: 'forms', urlSegment: 'forms', labelKey: 'x' }]);
        expect(result.unsupported).toEqual([]);
        expect(result.complete).toBe(true);
    });
});
