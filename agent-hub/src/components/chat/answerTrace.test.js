import { describe, it, expect } from 'vitest';

import { answerTraceFor, countSentences, traceSpanMs } from './answerTrace';

/**
 * Which rules the trail may show and, more importantly, which it may NOT invent.
 *
 * The hard rules:
 *   • a step without an event does not exist in the trail. It is missing, with a
 *     reason that concerns the MEASUREMENT and not the agent;
 *   • a search step without passages yields "not reported", never "0 results";
 *   • tone and language are never shown as fact. Nobody measures them;
 *   • the rule row is JUDGED and keeps that word, even when it stands next to four
 *     recorded rules;
 *   • a decision that falls after the turn updates rule 4.
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
        // `persona.tone.chips` and `persona.language` exist, but that is what was
        // REQUESTED. Nobody measures whether the answer hit that tone or was written
        // in that language. Showing them as fact would turn a wish into a result.
        const r = rowsById(fullTurn()).answer;
        expect(r.omitted).toEqual([
            { fact: 'tone', reason: 'not_measured' },
            { fact: 'language', reason: 'not_measured' },
        ]);
        expect(r).not.toHaveProperty('tone');
        expect(r).not.toHaveProperty('language');
    });

    it('BIJT — een zoekstap zonder passages meldt NIET "0 resultaten"', () => {
        // kb_sources only goes over the line if includeSourceReferences is on, and the
        // project KB injection never sends it. Zero passages therefore means "not
        // reported", not "nothing found".
        const msg = { ...fullTurn(), kbSources: [] };
        const r = rowsById(msg).sources;
        expect(r.state).toBe('recorded');
        expect(r.results).toBeNull();
        expect(r.documents).toBeNull();
        expect(r.omitted).toContainEqual({ fact: 'results', reason: 'not_reported' });
    });

    it('BIJT — zonder kb_search-tool is er geen zoekterm om te tonen', () => {
        // The auto-injection searches without sending anything of its search query.
        // There is then nothing to show, and filling in the user's question would be a guess.
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
        // A missing step may not get a number or a name. Then on the screen it can no
        // longer be told apart from a measured step.
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
        // The pass runs only in a test chat, only for a role with doesNot bullets, and
        // returns nothing when it fails. None of those cases says anything about the
        // agent, so the reason must concern the check.
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
        // After a reload the message comes from the history: toolHistory and kbSources
        // are still there, the phase trail is not. "Nothing recorded" is then true;
        // "the agent did nothing" is not.
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
        // Server: the call has run. Click: it is going to run. The trail must be able
        // to keep those two apart, otherwise "it ran" stands next to something that
        // still has to happen.
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
        // Without cutting them away, the two sentences in the comment would count, and
    // "4 sentences" would stand under an answer of two.
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
        // And no "Not shown: number of results": there was no knowledge step to miss a
    // count from.
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
