// @vitest-environment node
/**
 * De feiten achter de testset-kaart (A4 deel D).
 *
 * Wat hier vastligt is de rekenregel achter "11 / 12 goed", en vooral de drie
 * gevallen waarin er GEEN getal mag staan: nooit gedraaid, niet gelezen, en
 * halverwege omgevallen. Plus dat een weigering ("er is geen model ingericht
 * om te beoordelen") nooit als een mislukte test binnenkomt.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/tests/testSetFacts.test.js
 */
import { describe, it, expect } from 'vitest';

import {
    RUN_STATE, PROGRESS, REFUSAL,
    summariseRun, problemFor, firstProblem, refusalFor,
    startProgress, applyRunEvent, endProgress, countPassed, justRanScore,
} from './testSetFacts';

const RAN_AT = '2026-09-07T12:00:00.000Z';
const before = '2026-09-06T12:00:00.000Z';
const after = '2026-09-08T12:00:00.000Z';

const item = (over = {}) => ({
    testId: 't1', name: 'Opening hours', status: 'pass', reason: 'Meets the expectations.',
    decidedBy: 'overall', toolsUsed: [], toolsMissing: [], toolsWithheld: [], forbiddenHits: [], ...over,
});

const run = (over = {}) => ({
    id: 'r1', agentId: 'a1', version: 3, passed: 11, total: 12, ranAt: RAN_AT,
    results: { items: Array.from({ length: 12 }, (_, i) => item({ testId: `t${i}`, status: i === 11 ? 'fail' : 'pass' })), source: 'published', agentRev: 12, unpublishedChanges: 5, testCount: 12 },
    ...over,
});

const tests = (n = 12) => Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, name: `Q${i}`, question: `q${i}`, createdAt: before, updatedAt: before,
}));

describe('summariseRun — wanneer er een getal mag staan', () => {
    it('een afgeronde run is een resultaat, met de versie erbij', () => {
        const s = summariseRun({ lastRun: run(), tests: tests() });
        expect(s.state).toBe(RUN_STATE.RESULT);
        expect(s.passed).toBe(11);
        expect(s.total).toBe(12);
        expect(s.version).toBe(3);
        expect(s.source).toBe('published');
        expect(s.unpublishedChanges).toBe(5);
    });

    it('nooit gedraaid is NIET "0 van de 12 goed"', () => {
        const s = summariseRun({ lastRun: null, tests: tests() });
        expect(s.state).toBe(RUN_STATE.NEVER);
        expect(s.passed).toBeNull();
        expect(s.total).toBeNull();
    });

    it('een laatste run die niet gelezen kon worden is een derde antwoord', () => {
        const s = summariseRun({ lastRun: null, lastRunUnknown: true, tests: tests() });
        expect(s.state).toBe(RUN_STATE.UNKNOWN);
        expect(s.passed).toBeNull();
    });

    it('onbekend wint van "er is geen rij" — ook als er toevallig wél een rij is', () => {
        expect(summariseRun({ lastRun: run(), lastRunUnknown: true }).state).toBe(RUN_STATE.UNKNOWN);
    });

    it('een run die zichzelf tegenspreekt is geen resultaat', () => {
        const cases = [
            ['geen total', run({ total: 0, passed: 0 })],
            ['total ontbreekt', run({ total: null })],
            ['meer goed dan gevraagd', run({ passed: 13, total: 12 })],
            ['halverwege omgevallen', run({ total: 12, passed: 3, results: { items: [item(), item(), item()] } })],
        ];
        for (const [label, row] of cases) {
            const s = summariseRun({ lastRun: row, tests: tests() });
            expect(s.state, label).toBe(RUN_STATE.UNFINISHED);
            expect(s.passed, label).toBeNull();
            expect(s.total, label).toBeNull();
        }
    });

    it('een oude rij zonder items telt gewoon, maar zegt dat de regels onbekend zijn', () => {
        const s = summariseRun({ lastRun: run({ results: { source: 'live' } }), tests: tests() });
        expect(s.state).toBe(RUN_STATE.RESULT);
        expect(s.itemsKnown).toBe(false);
        expect(s.items).toEqual([]);
    });
});

describe('summariseRun — waar de run over ging', () => {
    it('zegt hoeveel van de vragen van nu deze run dekte', () => {
        const s = summariseRun({ lastRun: run({ passed: 4, total: 5, results: { items: Array.from({ length: 5 }, () => item()) } }), tests: tests(12) });
        expect(s.coverage).toEqual({ ran: 5, of: 12, when: 'now' });
    });

    it('zonder een lijst vragen valt de dekking terug op wat er TOEN stond', () => {
        // `results.testCount` is hoeveel vragen deze agent had toen de run
        // liep. Dat is een ander feit dan "wat je nu hebt", en `when` is wat de
        // kaart nodig heeft om er niet de verkeerde zin bij te zetten.
        const s = summariseRun({ lastRun: run({ passed: 4, total: 5, results: { items: Array.from({ length: 5 }, () => item()), testCount: 9 } }) });
        expect(s.coverage).toEqual({ ran: 5, of: 9, when: 'then' });
    });

    it('en zonder allebei wordt er geen dekking beweerd', () => {
        const s = summariseRun({ lastRun: run({ results: { items: Array.from({ length: 12 }, () => item()) } }) });
        expect(s.coverage).toEqual({ ran: 12, of: null, when: 'now' });
    });

    it('een vraag die na de run is toegevoegd maakt de uitslag oud', () => {
        const withNew = [...tests(12), { id: 'new', createdAt: after, updatedAt: after }];
        const s = summariseRun({ lastRun: run(), tests: withNew });
        expect(s.stale.added).toBe(true);
        expect(s.stale.changed).toBe(false);
        expect(s.isStale).toBe(true);
    });

    it('een vraag die na de run is bewerkt telt als gewijzigd, niet als toegevoegd', () => {
        const edited = tests(12).map((t, i) => (i === 0 ? { ...t, updatedAt: after } : t));
        const s = summariseRun({ lastRun: run(), tests: edited });
        expect(s.stale.changed).toBe(true);
        expect(s.stale.added).toBe(false);
    });

    it('een vraag die sindsdien weg is telt als verwijderd', () => {
        const s = summariseRun({ lastRun: run(), tests: tests(11) });
        expect(s.stale.removed).toBe(true);
    });

    it('een set die niet veranderd is, is niet oud', () => {
        expect(summariseRun({ lastRun: run(), tests: tests() }).isStale).toBe(false);
    });
});

describe('problemFor / firstProblem — de faalregel', () => {
    it('een verboden woord dat er letterlijk staat is een feit, geen oordeel', () => {
        const p = problemFor(item({ status: 'fail', forbiddenHits: ['korting'], decidedBy: 'must_not_mention' }));
        expect(p.kind).toBe('forbidden');
        expect(p.names).toEqual(['korting']);
    });

    it('een ontbrekende tool gaat vóór de gesloten reden van de grader', () => {
        const p = problemFor(item({ status: 'fail', toolsMissing: ['kb_search'], decidedBy: 'overall' }));
        expect(p.kind).toBe('tools_missing');
        expect(p.names).toEqual(['kb_search']);
    });

    it('een fail zonder feiten draagt de gesloten reden van de grader', () => {
        expect(problemFor(item({ status: 'fail', decidedBy: 'rules' })).kind).toBe('decided:rules');
        expect(problemFor(item({ status: 'fail', decidedBy: null })).kind).toBe('decided:overall');
    });

    it('geblokkeerd en fout zijn eigen soorten, geen fail', () => {
        expect(problemFor(item({ status: 'blocked', toolsWithheld: ['gmail_send'] }))).toMatchObject({ status: 'blocked', kind: 'withheld', names: ['gmail_send'] });
        expect(problemFor(item({ status: 'error', reason: 'The agent could not answer: boom' }))).toMatchObject({ status: 'error', kind: 'ungraded' });
        expect(problemFor(item({ status: 'pass' }))).toBeNull();
    });

    it('toont de dringendste, niet de eerste in de lijst', () => {
        const rows = [
            item({ testId: 'a', status: 'blocked' }),
            item({ testId: 'b', status: 'error' }),
            item({ testId: 'c', status: 'fail' }),
            item({ testId: 'd', status: 'pass' }),
        ];
        const first = firstProblem(rows);
        expect(first.item.testId).toBe('c');
        expect(first.moreCount).toBe(2);
        expect(first.totalProblems).toBe(3);
    });

    it('een groene run heeft geen faalregel', () => {
        expect(firstProblem([item(), item()])).toBeNull();
        expect(firstProblem(null)).toBeNull();
    });
});

describe('refusalFor — een weigering is geen mislukte test', () => {
    it('herkent "geen beoordelaar ingericht" en zegt dat opnieuw proberen niet helpt', () => {
        const r = refusalFor({ status: 503, body: { code: 'no_grading_model', error: 'No AI model is configured to grade these answers.' } });
        expect(r.kind).toBe(REFUSAL.NO_GRADER);
        expect(r.retryable).toBe(false);
        expect(r.serverMessage).toMatch(/No AI model/);
    });

    it('onderscheidt "niet ingericht" van "kon je config niet lezen"', () => {
        expect(refusalFor({ status: 503, body: { code: 'grading_model_unavailable' } })).toMatchObject({ kind: REFUSAL.MODEL_UNREADABLE, retryable: true });
        expect(refusalFor({ status: 503, body: { code: 'no_suggestion_model' } })).toMatchObject({ kind: REFUSAL.NO_SUGGESTER, retryable: false });
    });

    it('kent de plafond- en poortcodes', () => {
        expect(refusalFor({ status: 429, body: { code: 'limit_reached' } }).kind).toBe(REFUSAL.LIMIT);
        expect(refusalFor({ status: 503, body: { code: 'org_check_failed' } }).kind).toBe(REFUSAL.CHECK_FAILED);
        expect(refusalFor({ status: 403, body: { code: 'agent_not_editable' } }).kind).toBe(REFUSAL.NOT_EDITABLE);
        expect(refusalFor({ status: 400, body: { code: 'no_tests' } }).kind).toBe(REFUSAL.NOTHING_TO_RUN);
    });

    it('een onbekende weigering blijft een weigering', () => {
        const r = refusalFor({ status: 500, body: { error: 'boom' } });
        expect(r.kind).toBe(REFUSAL.UNKNOWN);
        expect(r.status).toBe(500);
    });

    it('een geslaagd antwoord is geen weigering', () => {
        expect(refusalFor({ status: 200, body: { tests: [] } })).toBeNull();
    });
});

describe('applyRunEvent — een lopende run is geen uitslag', () => {
    it('telt resultaten zonder er een uitslag van te maken', () => {
        let s = startProgress();
        s = applyRunEvent(s, 'start', { total: 3 });
        s = applyRunEvent(s, 'test_result', item({ status: 'pass' }));
        s = applyRunEvent(s, 'test_result', item({ status: 'fail' }));
        expect(s.status).toBe(PROGRESS.RUNNING);
        expect(s.done).toBe(2);
        expect(s.total).toBe(3);
        expect(s.passed).toBeNull();
    });

    it('pas op "done" is het een uitslag', () => {
        let s = applyRunEvent(startProgress(), 'start', { total: 2 });
        s = applyRunEvent(s, 'test_result', item());
        s = applyRunEvent(s, 'test_result', item({ status: 'fail' }));
        s = applyRunEvent(s, 'done', { passed: 1, total: 2, run: { id: 'r9' } });
        expect(s.status).toBe(PROGRESS.COMPLETE);
        expect(s.passed).toBe(1);
        expect(s.run).toEqual({ id: 'r9' });
    });

    it('een stream die zonder "done" ophoudt is onafgemaakt, niet nul goed', () => {
        let s = applyRunEvent(startProgress(), 'start', { total: 9 });
        s = applyRunEvent(s, 'test_result', item());
        s = endProgress(s);
        expect(s.status).toBe(PROGRESS.UNFINISHED);
        expect(s.passed).toBeNull();
    });

    it('een error-event maakt er een weigering van, geen uitslag', () => {
        let s = applyRunEvent(startProgress(), 'start', { total: 2 });
        s = applyRunEvent(s, 'error', { error: 'The tests ran, but the result could not be saved.', code: 'not_saved' });
        expect(s.status).toBe(PROGRESS.UNFINISHED);
        expect(s.refusal.kind).toBe(REFUSAL.NOT_SAVED);
    });

    it('een afgeronde run blijft afgerond als de stream sluit', () => {
        const done = applyRunEvent(startProgress(), 'done', { passed: 0, total: 0 });
        expect(endProgress(done).status).toBe(PROGRESS.COMPLETE);
    });

    it('een "Test als"-run draagt dat hij niet bewaard is', () => {
        const s = applyRunEvent(startProgress(), 'done', { passed: 2, total: 2, run: null, notStored: 'test_as' });
        expect(s.notStored).toBe('test_as');
    });

    it('telt groen zoals de server: alleen pass', () => {
        expect(countPassed([item(), item({ status: 'blocked' }), item({ status: 'error' }), item({ status: 'fail' })])).toBe(1);
        expect(countPassed(undefined)).toBe(0);
    });

    it('gaat niet stuk op rommel', () => {
        expect(() => applyRunEvent(null, 'nonsense', null)).not.toThrow();
        expect(() => summariseRun()).not.toThrow();
        expect(() => summariseRun({ lastRun: 'nope', tests: 'nope' })).not.toThrow();
        expect(() => refusalFor()).not.toThrow();
    });
});

describe('BIJT — de bewakers die niemand uitoefende', () => {
    it('een rij met total 0 is geen "0 of 0 passed" maar een onafgeronde run', () => {
        // De kop van testSetFacts zegt dat de kaart de belofte van de route
        // ("een afgebroken run wordt niet opgeslagen") NIET mag aannemen: een
        // oude of handmatig bewerkte rij komt hier gewoon binnen.
        const s = summariseRun({ lastRun: run({ passed: 0, total: 0, results: { items: [] } }), tests: tests() });
        expect(s.state).toBe(RUN_STATE.UNFINISHED);
        expect(s.passed).toBe(null);
        expect(s.total).toBe(null);
    });

    it('een fout MIDDEN in de stream is geen "er is niets getest"', () => {
        // `run_failed` komt van de route pas nadat er al test_result-events
        // gestreamd zijn. Wat er niet gebeurde is opslaan, niet testen.
        const r = refusalFor({ status: 0, body: { code: 'run_failed', error: 'boom' } });
        expect(r.kind).toBe(REFUSAL.RUN_STOPPED);
        expect(r.kind).not.toBe(REFUSAL.UNKNOWN);
        expect(r.retryable).toBe(true);
    });

    it('een geweigerde LEZING draagt zijn code en is niet opnieuw te proberen', () => {
        const r = refusalFor({ status: 403, body: { code: 'agent_not_editable' } });
        expect(r.kind).toBe(REFUSAL.NOT_EDITABLE);
        expect(r.retryable).toBe(false);
    });
});

describe('justRanScore — de run die je zojuist zag', () => {
    const done = (over = {}) => ({
        status: PROGRESS.COMPLETE, total: 12, done: 12,
        items: Array.from({ length: 12 }, (_, i) => item({ testId: `t${i}`, status: 'fail' })),
        passed: 0, notStored: null, run: null, ...over,
    });

    it('telt DEZE run, niet de vorige opgeslagen', () => {
        expect(justRanScore(done())).toEqual({ passed: 0, total: 12, kept: false, notStored: null });
    });

    it('valt terug op onze eigen telling als het done-event er geen gaf', () => {
        const s = justRanScore(done({
            passed: null,
            items: [item({ status: 'pass' }), item({ status: 'fail' })],
            total: 2,
        }));
        expect(s.passed).toBe(1);
        expect(s.total).toBe(2);
    });

    it('een "Test als"-run is niet bewaard, en zegt dat', () => {
        expect(justRanScore(done({ notStored: 'test_as' })).kept).toBe(false);
        expect(justRanScore(done({ notStored: 'test_as' })).notStored).toBe('test_as');
    });

    it('een opgeslagen run is wél bewaard', () => {
        expect(justRanScore(done({ run: { id: 'r9' } })).kept).toBe(true);
    });

    it('een lopende of afgebroken run is geen uitslag', () => {
        expect(justRanScore({ status: PROGRESS.RUNNING, items: [] })).toBe(null);
        expect(justRanScore({ status: PROGRESS.UNFINISHED, items: [] })).toBe(null);
        expect(justRanScore(null)).toBe(null);
    });
});
