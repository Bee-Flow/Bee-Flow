// Unit tests voor "Laatst bewerkt" (recentWork.js).
//
// Twee helften, net als bij attentionChecks.test.js:
//   - de PURE lezer en samenvoeger, gevoerd met exact de payload die het
//     endpoint van die sectie teruggeeft;
//   - de runner, door een gestubde authFetch, zodat de drie antwoorden
//     (gelezen / geweigerd / gevallen) langs de weg lopen die het scherm ook
//     neemt.
//
// De regels die dit bestand eerlijk moet houden:
//   1. "niets gevonden" en "niet kunnen kijken" zijn twee verdicten;
//   2. een soort die geen status meldt krijgt er geen verzonnen;
//   3. een 403 is niet van jou en dus geen gat — een 500 wél.

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

/** Een sectie zoals studioNavSections hem oplevert (alleen wat dit model leest). */
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
            // Gelockt: een bordje, geen deur — niets te lezen, en geen gat.
            section('apps', { kind: 'app', locked: 'ceiling' }),
            // Geen bron in het register: Formulieren en Runs hebben er bewust geen.
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
        // De eerste rij heeft geen id en verdwijnt in de mapper. Een koppeling
        // op index zou de status van de weggevallen rij op de tweede plakken.
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
        // De envelope ontbreekt (`{ }` in plaats van `{ automations: [] }`):
        // dat is een antwoord dat deze client niet kan lezen.
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
        // Er staat werk op de lijst, en toch is hij niet heel: dat verschil is
        // precies wat het scherm moet kunnen zeggen.
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
        // Leeg én heel: hier mag "nog niets bewerkt" op het scherm.
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
        // Deze vier sturen de zin onder de lijst ("sommige soorten melden hier
        // geen status"). Krijgt er één er alsnog een, dan hoort die zin mee te
        // veranderen; verliest er één de zijne, dan verdwijnt er stilzwijgend
        // een woord van een rij. Tabellen kwamen erbij: hun `isPublished` is
        // een DOELGROEP, geen levenscyclus, en "Draft" op een tabel die
        // dagelijks gebruikt wordt is een verzonnen woord.
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
            // "onbekend" is iets anders dan "meldt er geen" en hoort hier niet.
            { kind: 'agent', status: RECENT_STATUS.UNKNOWN },
        ])).toEqual(['kb', 'skill']);
    });

    it('valt terug op de sectie als de soort ontbreekt, en verdraagt rommel', () => {
        expect(statuslessKinds([{ sectionId: 'solutions', status: RECENT_STATUS.UNSUPPORTED }])).toEqual(['solutions']);
        expect(statuslessKinds(null)).toEqual([]);
        expect(statuslessKinds([null])).toEqual([]);
    });
});

/* ── De poorten zelf, en wat deze build niet kan lezen ────────────────────── */

describe('runRecentWork — twee stiltes die geen stilte mogen zijn', () => {
    it('zonder antwoord op de poorten is er geen recht op "nog niets bewerkt"', async () => {
        // resolveStudioNav laat een gegate sectie helemaal WEG zolang de
        // entitlements laden of omvielen, dus die secties staan niet in
        // `sections` en kunnen hier niet gemist worden. Zonder deze vlag is
        // het gevolg: zeven lijsten nooit gevraagd, en "Nothing edited yet"
        // met complete: true eroverheen.
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
        // Ze staat wél in `sections` (StudioStart voegt runtimeStudioApps toe)
        // maar heeft geen endpoint-contract dat deze lijst kan lezen. Zwijgen
        // zou iemand die alleen daarin werkt "Nothing edited yet" opleveren.
        const remote = { id: 'security', urlSegment: 'security', label: () => 'Security', kind: null };
        const result = await runRecentWork([remote]);
        expect(result.unsupported).toEqual(['security']);
        expect(result.complete).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('een INGEBOUWDE sectie zonder bron blijft bewust stil', async () => {
        // Formulieren en Runs hebben er met opzet geen: een formulier IS een
        // automation, en een run is een gebeurtenis. Dat is geen gat.
        const result = await runRecentWork([{ id: 'forms', urlSegment: 'forms', labelKey: 'x' }]);
        expect(result.unsupported).toEqual([]);
        expect(result.complete).toBe(true);
    });
});
