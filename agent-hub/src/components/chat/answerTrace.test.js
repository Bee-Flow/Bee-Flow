import { describe, it, expect } from 'vitest';

import { answerTraceFor, countSentences, traceSpanMs } from './answerTrace';

/**
 * Welke regels het spoor mag tonen, en — belangrijker — welke het NIET mag
 * verzinnen.
 *
 * De harde regels:
 *   • een stap zonder event bestaat niet in het spoor; hij ontbreekt, met een
 *     reden die over de METING gaat en niet over de agent;
 *   • een zoekstap zonder passages levert "niet gemeld", nooit "0 resultaten";
 *   • toon en taal staan er nooit als feit — niemand meet ze;
 *   • de regelrij is GEOORDEELD en houdt dat woord, ook als hij naast vier
 *     opgetekende regels staat;
 *   • een beslissing die na de beurt alsnog valt, werkt regel 4 bij.
 */

const KEY = 'a'.repeat(32);

const step = (stage, over = {}) => ({
    stage, detail: null, startedAt: 1000, endedAt: 1100, durationMs: 100, ...over,
});

/** Een volle beurt: alle vijf de regels hebben een echte bron. */
const fullTurn = () => ({
    id: 'm-1',
    role: 'assistant',
    content: 'Dat kan. Ik heb het opgezocht.',
    phaseTrail: [
        step('processed_history', { startedAt: 1000, endedAt: 1020, durationMs: 20 }),
        step('building_prompt', { startedAt: 1020, endedAt: 1060, durationMs: 40 }),
        step('kb_search', { startedAt: 1060, endedAt: 1260, durationMs: 200 }),
        step('streaming_start', { detail: 'claude-opus-5', startedAt: 1300, endedAt: null, durationMs: null }),
    ],
    toolHistory: [{ name: 'kb_search', args: { query: 'verlofdagen' }, startTime: 1060, endTime: 1260, status: 'done' }],
    kbSources: [
        { title: 'Personeelshandboek', content: 'Twee dagen.' },
        { title: 'Personeelshandboek', content: 'Aanvragen via HR.' },
        { title: 'Verlofregeling', content: 'Maximaal 25 dagen.' },
    ],
    ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] },
    pendingToolCalls: [{ callId: 'c1', toolName: 'gmail_compose', effect: 'sends', argsKey: KEY, status: 'pending' }],
});

const rowsById = (msg, opts) => Object.fromEntries(
    answerTraceFor(msg, opts).rows.map(r => [r.id, r]),
);

describe('een volle beurt', () => {
    it('levert vijf regels, in vaste volgorde', () => {
        const { rows } = answerTraceFor(fullTurn());
        expect(rows.map(r => r.id)).toEqual(['question', 'sources', 'rule', 'held_action', 'answer']);
        expect(rows.map(r => r.state)).toEqual(['recorded', 'recorded', 'judged', 'recorded', 'recorded']);
    });

    it('regel 1 rust op de fases die er echt waren, met hun duur', () => {
        const r = rowsById(fullTurn()).question;
        expect(r.stages).toEqual(['processed_history', 'building_prompt']);
        expect(r.ms).toBe(60);
    });

    it('regel 2 draagt de zoekterm van de tool en telt passages én documenten', () => {
        const r = rowsById(fullTurn()).sources;
        expect(r.query).toBe('verlofdagen');
        expect(r.results).toBe(3);
        expect(r.documents).toBe(2);
        expect(r.ms).toBe(200);
        expect(r.omitted).toEqual([]);
    });

    it('regel 5 noemt het model uit streaming_start en telt de zinnen', () => {
        const r = rowsById(fullTurn()).answer;
        expect(r.model).toBe('claude-opus-5');
        expect(r.sentences).toBe(2);
    });
});

describe('wat er niet gemeten is', () => {
    it('BIJT — toon en taal zijn ALTIJD weggelaten, met de reden', () => {
        // `persona.tone.chips` en `persona.language` bestaan, maar dat is wat
        // er GEVRAAGD is. Niemand meet of het antwoord die toon trof of in die
        // taal geschreven is. Ze als feit tonen zou van een wens een uitslag
        // maken.
        const r = rowsById(fullTurn()).answer;
        expect(r.omitted).toEqual([
            { fact: 'tone', reason: 'not_measured' },
            { fact: 'language', reason: 'not_measured' },
        ]);
        expect(r).not.toHaveProperty('tone');
        expect(r).not.toHaveProperty('language');
    });

    it('BIJT — een zoekstap zonder passages meldt NIET "0 resultaten"', () => {
        // kb_sources gaat alleen over de lijn als includeSourceReferences aan
        // staat, en de project-KB-injectie zendt het nooit. Nul passages
        // betekent dus "niet gemeld", niet "niets gevonden".
        const msg = { ...fullTurn(), kbSources: [] };
        const r = rowsById(msg).sources;
        expect(r.state).toBe('recorded');
        expect(r.results).toBeNull();
        expect(r.documents).toBeNull();
        expect(r.omitted).toContainEqual({ fact: 'results', reason: 'not_reported' });
    });

    it('BIJT — zonder kb_search-tool is er geen zoekterm om te tonen', () => {
        // De auto-injectie zoekt zonder ook maar iets over zijn zoekvraag te
        // zenden. Er is dan niets te tonen, en de vraag van de gebruiker
        // invullen zou een gok zijn.
        const msg = { ...fullTurn(), toolHistory: [] };
        const r = rowsById(msg).sources;
        expect(r.query).toBeNull();
        expect(r.omitted).toContainEqual({ fact: 'query', reason: 'not_recorded' });
    });

    it('zonder streaming_start ontbreekt het model, met de reden', () => {
        const msg = { ...fullTurn(), phaseTrail: [step('building_prompt')] };
        const r = rowsById(msg).answer;
        expect(r.model).toBeNull();
        expect(r.omitted).toContainEqual({ fact: 'model', reason: 'not_recorded' });
    });
});

describe('een beurt zonder tools', () => {
    const plain = () => ({
        id: 'm-2',
        role: 'assistant',
        content: 'Goedemorgen! Hoe kan ik helpen?',
        phaseTrail: [
            step('processed_history', { durationMs: 12 }),
            step('building_prompt', { durationMs: 30 }),
            step('streaming_start', { detail: 'claude-haiku-4-5', endedAt: null, durationMs: null }),
        ],
    });

    it('toont wat er wél was en laat de rest ONTBREKEN, met de reden', () => {
        const rows = rowsById(plain());
        expect(rows.question.state).toBe('recorded');
        expect(rows.answer.state).toBe('recorded');
        expect(rows.sources).toMatchObject({ state: 'missing', reason: 'not_recorded' });
        expect(rows.held_action).toMatchObject({ state: 'missing', reason: 'not_recorded' });
    });

    it('BIJT — een ontbrekende regel draagt geen feiten', () => {
        // Een ontbrekende stap mag nergens een getal of een naam bij krijgen:
        // dan is hij op het scherm niet meer van een gemeten stap te
        // onderscheiden.
        const rows = rowsById(plain());
        expect(rows.sources).not.toHaveProperty('results');
        expect(rows.sources).not.toHaveProperty('query');
        expect(rows.held_action).not.toHaveProperty('actions');
    });

    it('het spoor is niet leeg — er is wel degelijk iets opgetekend', () => {
        expect(answerTraceFor(plain()).isEmpty).toBe(false);
        expect(answerTraceFor(plain()).tools).toEqual([]);
    });
});

describe('een beurt waarin de attributie ontbreekt', () => {
    it('regel 3 ontbreekt, met een reden over de CONTROLE', () => {
        // De pass draait alleen in een testchat, alleen bij een rol met
        // doesNot-bullets, en geeft niets terug als hij omvalt. Geen van die
        // gevallen zegt iets over de agent — de reden moet dus over de
        // controle gaan.
        const msg = { ...fullTurn(), ruleAttribution: undefined };
        expect(rowsById(msg).rule).toMatchObject({ state: 'missing', reason: 'no_attribution' });
    });

    it('BIJT — een leeg of onleesbaar attributie-payload wordt geen regel', () => {
        for (const bad of [{}, { rules: [] }, { rules: 'nope' }, { rules: [{ rule: '  ' }, null] }]) {
            const msg = { ...fullTurn(), ruleAttribution: bad };
            expect(rowsById(msg).rule.state).toBe('missing');
        }
    });

    it('de rest van het spoor blijft gewoon staan', () => {
        const msg = { ...fullTurn(), ruleAttribution: null };
        const rows = rowsById(msg);
        expect([rows.question.state, rows.sources.state, rows.answer.state])
            .toEqual(['recorded', 'recorded', 'recorded']);
    });

    it('BIJT — de regelrij blijft GEOORDEELD, ook naast vier opgetekende regels', () => {
        // Vier notulen en één mening in dezelfde lijst: als de mening
        // 'recorded' zou heten, leest het paneel als één soort bewijs.
        expect(rowsById(fullTurn()).rule.state).toBe('judged');
    });
});

describe('zonder spoor', () => {
    it('een herladen bericht zegt dat er NIETS opgetekend is', () => {
        // Na een herlaadbeurt komt het bericht uit de historie: toolHistory en
        // kbSources zijn er nog, het fase-spoor niet. "Niets opgetekend" is dan
        // waar; "de agent deed niets" niet.
        const rows = rowsById({ id: 'm-3', role: 'assistant', content: '' });
        expect(rows.question).toMatchObject({ state: 'missing', reason: 'no_trace' });
        expect(rows.sources).toMatchObject({ state: 'missing', reason: 'no_trace' });
        expect(rows.answer).toMatchObject({ state: 'missing', reason: 'no_trace' });
        expect(answerTraceFor({ id: 'm-3' }).isEmpty).toBe(true);
    });

    it('maar met een antwoord in de hand is regel 5 gewoon te meten', () => {
        const rows = rowsById({ id: 'm-4', role: 'assistant', content: 'Klaar.' });
        expect(rows.answer).toMatchObject({ state: 'recorded', sentences: 1, model: null });
    });
});

describe('een beslissing die daarna alsnog valt', () => {
    it('regel 4 zegt eerst: aangeboden, niet gestart', () => {
        const r = rowsById(fullTurn()).held_action;
        expect(r.openCount).toBe(1);
        expect(r.actions[0]).toMatchObject({ toolName: 'gmail_compose', status: 'pending', by: null });
    });

    it('BIJT — een klik in deze sessie werkt de regel bij, zonder nieuwe beurt', () => {
        const r = rowsById(fullTurn(), { toolDecisions: { [KEY]: 'approve' } }).held_action;
        expect(r.actions[0]).toMatchObject({ status: 'approved', by: 'session' });
        expect(r.openCount).toBe(0);
    });

    it('BIJT — een goedkeuring van de SERVER is iets anders dan een klik', () => {
        // Server: de call heeft gedraaid. Klik: hij gaat draaien. Het spoor
        // moet die twee uit elkaar kunnen houden, anders staat er "it ran" bij
        // iets dat nog moet gebeuren.
        const msg = fullTurn();
        msg.pendingToolCalls = [{ ...msg.pendingToolCalls[0], status: 'approved' }];
        expect(rowsById(msg).held_action.actions[0]).toMatchObject({ status: 'approved', by: 'server' });
    });

    it('een afwijzing sluit de regel ook', () => {
        const r = rowsById(fullTurn(), { toolDecisions: { [KEY]: 'decline' } }).held_action;
        expect(r.actions[0].status).toBe('declined');
        expect(r.openCount).toBe(0);
    });
});

describe('de spanwijdte', () => {
    it('BIJT — is niet de SOM van de duren; fases schuiven over elkaar heen', () => {
        // guardrails loopt om privacy_scan heen. Optellen (60 + 40) telt de
        // scan twee keer en maakt de beurt langer dan hij was.
        const trail = [
            step('guardrails', { startedAt: 1000, endedAt: 1060, durationMs: 60 }),
            step('privacy_scan', { startedAt: 1010, endedAt: 1050, durationMs: 40 }),
        ];
        expect(traceSpanMs(trail)).toBe(60);
    });

    it('geen spoor of één tik levert geen spanwijdte', () => {
        expect(traceSpanMs([])).toBeNull();
        expect(traceSpanMs(null)).toBeNull();
        expect(traceSpanMs([step('x', { startedAt: 5, endedAt: null, durationMs: null })])).toBeNull();
    });
});

describe('zinnen tellen', () => {
    it('telt zinnen, geen punten', () => {
        expect(countSentences('Eén zin.')).toBe(1);
        expect(countSentences('Eerste. Tweede! Derde?')).toBe(3);
        expect(countSentences('Zonder eindteken')).toBe(1);
        expect(countSentences('')).toBe(0);
        expect(countSentences(null)).toBe(0);
    });

    it('BIJT — een codeblok is geen proza en blaast de telling niet op', () => {
        const text = 'Zo doe je dat. \n```js\n// Eerst dit. Dan dat.\nconsole.log(1);\n```\nKlaar.';
        expect(countSentences(text)).toBe(2);
        // Zonder het wegknippen zouden de twee zinnen in het commentaar
        // meetellen en stond er "4 sentences" onder een antwoord van twee.
        expect(countSentences('Zo doe je dat. // Eerst dit. Dan dat. Klaar.')).toBe(4);
    });

    it('BIJT — een decimaal is geen zinseinde', () => {
        expect(countSentences('Het is 3.5 procent.')).toBe(1);
        expect(countSentences('Zie foo.bar voor meer.')).toBe(1);
    });
});

describe('BIJT — een tabelrij is geen document', () => {
    it('telt tabelrijen in hun eigen eenheid, niet als passages uit documenten', () => {
        // `datatable_query` emit `kb_sources` met `kind: 'datatable_row'` en de
        // RIJNAAM als titel. Ze meetellen als passages gaf bij drie rijen
        // letterlijk "3 passages from 3 documents": één tabel gelezen, geen
        // drie documenten, en geen kennisbank geraadpleegd.
        const row = answerTraceFor({
            toolHistory: [{ name: 'datatable_query', args: {}, startTime: 10, endTime: 40 }],
            kbSources: [
                { kind: 'datatable_row', title: 'Jan Jansen', sourceName: 'Klanten', content: 'x' },
                { kind: 'datatable_row', title: 'Piet Peters', sourceName: 'Klanten', content: 'y' },
                { kind: 'datatable_row', title: 'Klaas Klaassen', sourceName: 'Klanten', content: 'z' },
            ],
        }).rows.find(r => r.id === 'sources');

        expect(row.state).toBe('recorded');
        expect(row.results).toBe(null);
        expect(row.documents).toBe(null);
        expect(row.rows).toBe(3);
        expect(row.tables).toBe(1);
        // En geen "Not shown: number of results": er was geen kennisstap om
        // een aantal van te missen.
        expect(row.omitted).toEqual([]);
    });

    it('een beurt met allebei telt allebei apart', () => {
        const row = answerTraceFor({
            toolHistory: [{ name: 'kb_search', args: { query: 'verlof' } }, { name: 'datatable_query', args: {} }],
            kbSources: [
                { kind: 'kb_chunk', title: 'Handboek', content: 'a' },
                { kind: 'datatable_row', title: 'Jan', sourceName: 'Klanten', content: 'b' },
            ],
        }).rows.find(r => r.id === 'sources');
        expect(row.results).toBe(1);
        expect(row.documents).toBe(1);
        expect(row.rows).toBe(1);
        expect(row.tables).toBe(1);
    });
});

describe('BIJT — alle zoektermen, niet de eerste', () => {
    it('twee kb_search-calls leveren twee termen', () => {
        const row = answerTraceFor({
            toolHistory: [
                { name: 'kb_search', args: { query: 'a' }, startTime: 0, endTime: 100 },
                { name: 'kb_search', args: { query: 'b' }, startTime: 100, endTime: 400 },
            ],
            kbSources: [{ kind: 'kb_chunk', title: 'Handboek', content: 'x' }],
        }).rows.find(r => r.id === 'sources');
        expect(row.queries).toEqual(['a', 'b']);
        expect(row.omitted).toEqual([]);
    });

    it('zonder term staat dat als weglating in het spoor', () => {
        const row = answerTraceFor({
            phaseTrail: [{ stage: 'kb_search', startedAt: 1, endedAt: 2, durationMs: 1 }],
            kbSources: [{ kind: 'kb_chunk', title: 'Handboek', content: 'x' }],
        }).rows.find(r => r.id === 'sources');
        expect(row.queries).toEqual([]);
        expect(row.omitted).toContainEqual({ fact: 'query', reason: 'not_recorded' });
    });
});

describe('BIJT — er staat nooit een 0 waar niemand geteld heeft', () => {
    it('een antwoord dat alleen code is telt geen zinnen', () => {
        const row = answerTraceFor({
            content: '```js\nconsole.log(1);\n```',
            phaseTrail: [{ stage: 'streaming_start', detail: 'claude-opus-5', startedAt: 10 }],
        }).rows.find(r => r.id === 'answer');
        expect(row.sentences).toBe(null);
        expect(row.omitted).toContainEqual({ fact: 'sentences', reason: 'no_prose' });
    });

    it('proza telt gewoon', () => {
        const row = answerTraceFor({
            content: 'Dat kan. Ik heb het opgezocht.',
            phaseTrail: [{ stage: 'streaming_start', detail: 'claude-opus-5', startedAt: 10 }],
        }).rows.find(r => r.id === 'answer');
        expect(row.sentences).toBe(2);
        expect(row.omitted).not.toContainEqual({ fact: 'sentences', reason: 'no_prose' });
    });
});

describe('BIJT — waar de klok stopt', () => {
    it('een spoor dat op streaming_start eindigt is OPEN', () => {
        const trace = answerTraceFor({
            content: 'Klaar.',
            phaseTrail: [
                { stage: 'building_prompt', startedAt: 1000, endedAt: 1060, durationMs: 60 },
                { stage: 'streaming_start', detail: 'm', startedAt: 1300, endedAt: null },
            ],
        });
        expect(trace.spanMs).toBe(300);
        expect(trace.spanOpen).toBe(true);
    });

    it('een spoor dat netjes afsluit is dat niet', () => {
        const trace = answerTraceFor({
            content: 'Klaar.',
            phaseTrail: [{ stage: 'building_prompt', startedAt: 1000, endedAt: 1060, durationMs: 60 }],
        });
        expect(trace.spanMs).toBe(60);
        expect(trace.spanOpen).toBe(false);
    });
});
