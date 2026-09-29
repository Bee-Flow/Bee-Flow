/**
 * De testset-kaart (A4 deel D).
 *
 * Wat hier bewaakt wordt is niet de opmaak maar wat de kaart BEWEERT:
 *
 *   • "11 / 12 goed" staat er alleen na een afgeronde run. Nooit gedraaid,
 *     niet gelezen en halverwege omgevallen krijgen alle drie hun eigen zin en
 *     geen van drieën een getal;
 *   • de faalregel zegt WAAROM, en een `blocked` of `error` wordt niet als
 *     fout van de agent getekend;
 *   • een weigering ("geen model ingericht om te beoordelen") is een
 *     weigering, geen rode test — en ze laat de telling met rust;
 *   • een knop die nergens heen kan staat er niet.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/tests/TestSetCard.test.jsx
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import TestSetCard from './TestSetCard';
import { refusalFor, startProgress, applyRunEvent, endProgress } from './testSetFacts';
import { READ } from '../canUse/canUseFacts';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const RAN_AT = '2026-09-07T12:00:00.000Z';

const item = (over = {}) => ({
    testId: 't0', name: 'Opening hours', status: 'pass', reason: 'Meets the expectations.',
    decidedBy: 'overall', toolsUsed: [], toolsMissing: [], toolsWithheld: [], forbiddenHits: [], ...over,
});

const tests = (n = 12) => Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, name: `Question ${i}`, question: `q${i}`,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
}));

const run = (over = {}) => ({
    id: 'r1', version: 3, passed: 11, total: 12, ranAt: RAN_AT,
    results: {
        items: Array.from({ length: 12 }, (_, i) => item({
            testId: `t${i}`, name: `Question ${i}`,
            status: i === 11 ? 'fail' : 'pass',
            decidedBy: i === 11 ? 'must_mention' : 'overall',
        })),
        source: 'published', agentRev: 12, unpublishedChanges: 0, testCount: 12,
    },
    ...over,
});

const base = { t, tests: tests(), rel: () => 'yesterday' };

afterEach(() => cleanup());

describe('TestSetCard — de telling', () => {
    it('toont "11 of 12 passed" na een afgeronde run', () => {
        render(<TestSetCard {...base} lastRun={run()} />);
        const score = screen.getByTestId('agent-tests-score');
        expect(score).toHaveAttribute('data-state', 'result');
        expect(score.textContent).toBe('11 of 12 passed');
    });

    it('BIJT — nooit gedraaid is "Not run yet", niet "0 of 12"', () => {
        render(<TestSetCard {...base} lastRun={null} />);
        const score = screen.getByTestId('agent-tests-score');
        expect(score).toHaveAttribute('data-state', 'never');
        expect(score.textContent).toMatch(/Not run yet/);
        expect(document.body.textContent).not.toMatch(/0 of 12/);
        // De set zelf wordt wél geteld — dat is een feit over de vragen.
        expect(screen.getByTestId('agent-tests-question-count').textContent).toBe('12 questions');
    });

    it('een laatste run die niet gelezen kon worden claimt niets', () => {
        render(<TestSetCard {...base} lastRun={null} lastRunUnknown />);
        const score = screen.getByTestId('agent-tests-score');
        expect(score).toHaveAttribute('data-state', 'unknown');
        expect(score.textContent).toMatch(/Could not read the last run/);
        expect(document.body.textContent).not.toMatch(/passed/);
    });

    it('een opgeslagen run die zichzelf tegenspreekt levert geen score op', () => {
        const halfway = run({ total: 12, passed: 3, results: { items: [item(), item(), item()], source: 'published' } });
        render(<TestSetCard {...base} lastRun={halfway} />);
        expect(screen.getByTestId('agent-tests-score')).toHaveAttribute('data-state', 'unfinished');
        expect(document.body.textContent).not.toMatch(/3 of 12/);
    });

    it('zegt over welke versie de uitslag gaat, en hoeveel er sindsdien wacht', () => {
        render(<TestSetCard {...base} lastRun={run({ results: { ...run().results, unpublishedChanges: 5 } })} />);
        const about = screen.getByTestId('agent-tests-about').textContent;
        expect(about).toMatch(/about v3/);
        expect(about).toMatch(/5 unpublished changes since/);
    });

    it('gebruikt het enkelvoud bij één ongepubliceerde wijziging', () => {
        render(<TestSetCard {...base} lastRun={run({ results: { ...run().results, unpublishedChanges: 1 } })} />);
        expect(screen.getByTestId('agent-tests-about').textContent).toMatch(/1 unpublished change since/);
    });

    it('zegt het als de uitslag maar een deel van de vragen van nu dekt', () => {
        const partial = run({
            passed: 4, total: 5,
            results: { items: Array.from({ length: 5 }, (_, i) => item({ testId: `t${i}` })), source: 'live' },
        });
        render(<TestSetCard {...base} lastRun={partial} />);
        expect(screen.getByTestId('agent-tests-about').textContent).toMatch(/covers 5 of the 12 questions you have now/);
    });

    it('zegt het als er sinds de run aan de vragen gesleuteld is', () => {
        const edited = tests(12).map((x, i) => (i === 0 ? { ...x, updatedAt: '2026-09-08T00:00:00.000Z' } : x));
        render(<TestSetCard {...base} tests={edited} lastRun={run()} />);
        expect(screen.getByTestId('agent-tests-about').textContent).toMatch(/changed after this run/);
    });
});

describe('TestSetCard — de faalregel', () => {
    it('noemt de vraag en waarom hij niet groen is', () => {
        render(<TestSetCard {...base} lastRun={run()} />);
        const line = screen.getByTestId('agent-tests-fail-line');
        expect(line).toHaveAttribute('data-status', 'fail');
        expect(line.textContent).toMatch(/Question 11/);
        expect(line.textContent).toMatch(/Did not get across everything this test asks for/);
    });

    it('een letterlijk verboden woord wordt als feit genoemd, niet als oordeel', () => {
        const withForbidden = run({
            passed: 11,
            results: {
                ...run().results,
                items: [
                    ...Array.from({ length: 11 }, (_, i) => item({ testId: `t${i}` })),
                    item({ testId: 't11', name: 'Discount', status: 'fail', forbiddenHits: ['korting'], decidedBy: 'must_not_mention' }),
                ],
            },
        });
        render(<TestSetCard {...base} lastRun={withForbidden} />);
        expect(screen.getByTestId('agent-tests-fail-line').textContent).toMatch(/Said something this test forbids: korting/);
    });

    it('BIJT — geblokkeerd is geen fout van de agent', () => {
        const blocked = run({
            passed: 11,
            results: {
                ...run().results,
                items: [
                    ...Array.from({ length: 11 }, (_, i) => item({ testId: `t${i}` })),
                    item({ testId: 't11', name: 'Mail the customer', status: 'blocked', toolsWithheld: ['gmail_send'] }),
                ],
            },
        });
        render(<TestSetCard {...base} lastRun={blocked} />);
        const line = screen.getByTestId('agent-tests-fail-line');
        expect(line).toHaveAttribute('data-status', 'blocked');
        expect(line.textContent).toMatch(/A test run never uses gmail_send/);
        expect(line.textContent).not.toMatch(/Did not/);
    });

    it('toont de dringendste en telt de rest', () => {
        const mixed = run({
            passed: 9,
            results: {
                ...run().results,
                items: [
                    ...Array.from({ length: 9 }, (_, i) => item({ testId: `t${i}` })),
                    item({ testId: 't9', name: 'Blocked one', status: 'blocked', toolsWithheld: ['gmail_send'] }),
                    item({ testId: 't10', name: 'Errored one', status: 'error' }),
                    item({ testId: 't11', name: 'Failed one', status: 'fail', decidedBy: 'rules' }),
                ],
            },
        });
        render(<TestSetCard {...base} lastRun={mixed} />);
        expect(screen.getByTestId('agent-tests-fail-line').textContent).toMatch(/Failed one/);
        expect(screen.getByTestId('agent-tests-more-problems').textContent).toBe('2 more questions are not green.');
    });

    it('een groene run heeft geen faalregel', () => {
        const green = run({ passed: 12, results: { ...run().results, items: Array.from({ length: 12 }, (_, i) => item({ testId: `t${i}` })) } });
        render(<TestSetCard {...base} lastRun={green} />);
        expect(screen.queryByTestId('agent-tests-fail-line')).toBeNull();
    });
});

describe('TestSetCard — een weigering is geen mislukte test', () => {
    it('BIJT — "geen beoordelaar ingericht" komt als weigering, en de telling blijft "nog niet gedraaid"', () => {
        const refusal = refusalFor({ status: 503, body: { code: 'no_grading_model', error: 'No AI model is configured to grade these answers.' } });
        render(<TestSetCard {...base} lastRun={null} refusal={refusal} onRetryRun={() => {}} />);
        const notice = screen.getByTestId('agent-tests-refusal');
        expect(notice).toHaveAttribute('data-kind', 'no_grader');
        expect(notice.textContent).toMatch(/nothing was tested/i);
        // En niet als rood resultaat: geen faalregel, geen getal.
        expect(screen.queryByTestId('agent-tests-fail-line')).toBeNull();
        expect(screen.getByTestId('agent-tests-score')).toHaveAttribute('data-state', 'never');
        // Opnieuw proberen helpt hier niet, dus die knop staat er niet.
        expect(screen.queryByTestId('agent-tests-refusal-retry')).toBeNull();
    });

    it('een lezing die omviel biedt wél opnieuw proberen', () => {
        const onRetryRun = vi.fn();
        render(<TestSetCard {...base} refusal={refusalFor({ status: 503, body: { code: 'org_check_failed' } })} onRetryRun={onRetryRun} />);
        fireEvent.click(screen.getByTestId('agent-tests-refusal-retry'));
        expect(onRetryRun).toHaveBeenCalled();
    });

    it('een eerdere uitslag blijft staan als een nieuwe poging geweigerd wordt', () => {
        render(<TestSetCard {...base} lastRun={run()} refusal={refusalFor({ status: 429, body: { code: 'limit_reached' } })} />);
        expect(screen.getByTestId('agent-tests-score').textContent).toBe('11 of 12 passed');
        expect(screen.getByTestId('agent-tests-refusal')).toHaveAttribute('data-kind', 'limit');
    });

    it('"de tests liepen maar konden niet worden bewaard" zegt dat de score niet bewaard is', () => {
        render(<TestSetCard {...base} refusal={refusalFor({ status: 200, body: { code: 'not_saved' } })} />);
        expect(screen.getByTestId('agent-tests-refusal').textContent).toMatch(/not kept/i);
    });
});

describe('TestSetCard — een lopende run', () => {
    it('toont voortgang, geen tussenstand', () => {
        let p = applyRunEvent(startProgress(), 'start', { total: 12 });
        p = applyRunEvent(p, 'test_result', item({ testId: 't0' }));
        p = applyRunEvent(p, 'test_result', item({ testId: 't1', status: 'fail' }));
        render(<TestSetCard {...base} lastRun={run()} progress={p} running />);
        const score = screen.getByTestId('agent-tests-score');
        expect(score).toHaveAttribute('data-state', 'running');
        expect(score.textContent).toBe('Running… 2 of 12');
        expect(score.textContent).not.toMatch(/passed/);
    });

    it('BIJT — een stream die zonder "done" ophoudt levert geen uitslag', () => {
        let p = applyRunEvent(startProgress(), 'start', { total: 12 });
        p = applyRunEvent(p, 'test_result', item({ testId: 't0' }));
        p = endProgress(p);
        render(<TestSetCard {...base} lastRun={null} progress={p} />);
        const score = screen.getByTestId('agent-tests-score');
        expect(score).toHaveAttribute('data-state', 'unfinished');
        expect(score.textContent).toMatch(/did not finish/);
        expect(document.body.textContent).not.toMatch(/1 of 12 passed/);
    });
});

describe('TestSetCard — Bekijk', () => {
    it('vouwt de vragen en de historie open, en haalt ze pas dan op', () => {
        const onOpenDetail = vi.fn();
        render(<TestSetCard {...base} lastRun={run()} runs={[{ id: 'r1', passed: 11, total: 12, ranAt: RAN_AT, version: 3, results: { items: [] } }]} onOpenDetail={onOpenDetail} />);
        expect(screen.queryByTestId('agent-tests-detail')).toBeNull();
        expect(onOpenDetail).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('agent-tests-view'));
        expect(onOpenDetail).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('agent-tests-detail')).toBeInTheDocument();
        expect(screen.getAllByTestId('agent-tests-question-row')).toHaveLength(12);
        expect(screen.getAllByTestId('agent-tests-run-row')).toHaveLength(1);
    });

    it('een vraag die niet in de laatste run zat krijgt geen oordeel', () => {
        const withExtra = [...tests(12), { id: 'brand-new', name: 'Brand new', question: 'q', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }];
        render(<TestSetCard {...base} tests={withExtra} lastRun={run()} />);
        fireEvent.click(screen.getByTestId('agent-tests-view'));
        const rows = screen.getAllByTestId('agent-tests-question-row');
        const last = rows[rows.length - 1];
        expect(last).toHaveAttribute('data-status', 'none');
        expect(last.textContent).toMatch(/Not part of the last run/);
    });

    it('BIJT — een historie die niet gelezen kon worden is geen lege historie', () => {
        render(<TestSetCard {...base} lastRun={run()} runs={[]} runsUnknown />);
        fireEvent.click(screen.getByTestId('agent-tests-view'));
        expect(screen.getByTestId('agent-tests-runs-unreadable')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-tests-runs-empty')).toBeNull();
    });

    it('zegt hoeveel runs er bewaard blijven zodra de lijst vol is', () => {
        const many = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, passed: 1, total: 1, ranAt: RAN_AT, version: 1, results: { items: [] } }));
        render(<TestSetCard {...base} lastRun={run()} runs={many} runsKeep={20} />);
        fireEvent.click(screen.getByTestId('agent-tests-view'));
        expect(screen.getByTestId('agent-tests-runs-pruned').textContent).toBe('Only the last 20 runs are kept.');
    });

    it('een run in de historie die niet afgerond is, toont geen score', () => {
        render(<TestSetCard {...base} runs={[{ id: 'r1', passed: 5, total: 0, ranAt: RAN_AT, results: {} }]} />);
        fireEvent.click(screen.getByTestId('agent-tests-view'));
        const row = screen.getByTestId('agent-tests-run-row');
        expect(row).toHaveAttribute('data-state', 'unfinished');
        expect(row.textContent).not.toMatch(/5 of 0/);
    });
});

describe('TestSetCard — de knoppen', () => {
    it('"+ Dit gesprek als test" staat er alleen als er een gesprek is', () => {
        const onAddFromChat = vi.fn();
        const { rerender } = render(<TestSetCard {...base} onAddFromChat={onAddFromChat} canAddFromChat={false} />);
        expect(screen.queryByTestId('agent-tests-add-from-chat')).toBeNull();
        expect(screen.getByTestId('agent-tests-add-hint')).toBeInTheDocument();

        rerender(<TestSetCard {...base} onAddFromChat={onAddFromChat} canAddFromChat />);
        fireEvent.click(screen.getByTestId('agent-tests-add-from-chat'));
        expect(onAddFromChat).toHaveBeenCalled();
    });

    it('alleen-lezen haalt de acties weg, niet de feiten', () => {
        render(<TestSetCard {...base} ro lastRun={run()} onRun={() => {}} onAddFromChat={() => {}} canAddFromChat />);
        expect(screen.queryByTestId('agent-tests-run')).toBeNull();
        expect(screen.queryByTestId('agent-tests-add-from-chat')).toBeNull();
        expect(screen.getByTestId('agent-tests-score').textContent).toBe('11 of 12 passed');
        expect(screen.getByTestId('agent-tests-view')).toBeInTheDocument();
    });

    it('Run doet niets zonder vragen', () => {
        const onRun = vi.fn();
        render(<TestSetCard {...base} tests={[]} onRun={onRun} />);
        expect(screen.getByTestId('agent-tests-run')).toBeDisabled();
    });

    it('een lijst vragen die niet te lezen was, zegt dat erbij', () => {
        const onRetryTests = vi.fn();
        render(<TestSetCard {...base} tests={[]} testsState={READ.ERROR} onRetryTests={onRetryTests} />);
        expect(screen.getByTestId('agent-tests-unreadable')).toBeInTheDocument();
    });
});

describe('BIJT — een run die niet bewaard is, en de kopregel', () => {
    /** Een `done` dat de server stuurt zonder rij: 12 rode vragen, niets opgeslagen. */
    const unstoredProgress = (over = {}) => {
        let state = startProgress();
        state = applyRunEvent(state, 'start', { total: 12 });
        for (let i = 0; i < 12; i++) {
            state = applyRunEvent(state, 'test_result', item({ testId: `t${i}`, name: `Question ${i}`, status: 'fail', decidedBy: 'must_mention' }));
        }
        state = applyRunEvent(state, 'done', { run: null, passed: 0, total: 12, ...over });
        return endProgress(state);
    };

    it('de kopregel gaat over de run die zojuist liep, niet over de vorige', () => {
        // Vorige opgeslagen run: 11/12. Nieuwe run: 12× rood, niet bewaard.
        // De faalregel eronder gaat over de nieuwe; de telling deed dat niet.
        render(<TestSetCard {...base} lastRun={run()} progress={unstoredProgress({ notStored: 'test_as' })} />);
        const score = screen.getByTestId('agent-tests-score');
        expect(score.textContent).toBe('0 of 12 passed');
        expect(score.textContent).not.toMatch(/11 of 12/);
        expect(score).toHaveAttribute('data-kept', 'no');
    });

    it('en zegt dat die uitslag nergens bewaard is', () => {
        render(<TestSetCard {...base} lastRun={run()} progress={unstoredProgress({ notStored: 'test_as' })} />);
        expect(screen.getByTestId('agent-tests-not-kept').textContent)
            .toBe('This was a simulation for one group, so the score is not kept.');
    });

    it('de versieregel van de VORIGE run staat er dan niet meer bij', () => {
        // "about v3" boven een score die niets met v3 te maken heeft.
        render(<TestSetCard {...base} lastRun={run()} progress={unstoredProgress({ notStored: 'test_as' })} />);
        expect(screen.queryByTestId('agent-tests-about')).toBeNull();
    });

    it('een run die WEL bewaard is houdt zijn versieregel', () => {
        render(<TestSetCard {...base} lastRun={run()} progress={unstoredProgress({ run: { id: 'r2' }, passed: 11 })} />);
        expect(screen.getByTestId('agent-tests-score')).toHaveAttribute('data-kept', 'yes');
        expect(screen.queryByTestId('agent-tests-not-kept')).toBeNull();
        expect(screen.getByTestId('agent-tests-about')).toBeTruthy();
    });

    it('een mislukte opslag zegt "niet bewaard", niet "niet getest"', () => {
        const failed = unstoredProgress({ run: null, passed: 3 });
        render(
            <TestSetCard {...base} lastRun={run()} progress={failed}
                refusal={refusalFor({ status: 0, body: { code: 'not_saved' } })} />,
        );
        expect(screen.getByTestId('agent-tests-score').textContent).toBe('3 of 12 passed');
        expect(screen.getByTestId('agent-tests-refusal').textContent)
            .toMatch(/could not be saved/);
    });
});

describe('BIJT — een fout midden in de stream', () => {
    it('zegt niet "Nothing was tested" terwijl de resultaten eronder staan', () => {
        let state = startProgress();
        state = applyRunEvent(state, 'start', { total: 12 });
        for (let i = 0; i < 5; i++) {
            state = applyRunEvent(state, 'test_result', item({ testId: `t${i}`, name: `Question ${i}`, status: i === 4 ? 'fail' : 'pass' }));
        }
        state = applyRunEvent(state, 'error', { code: 'run_failed', error: 'boom' });
        render(
            <TestSetCard {...base} progress={endProgress(state)}
                refusal={refusalFor({ status: 0, body: { code: 'run_failed' } })} />,
        );
        const banner = screen.getByTestId('agent-tests-refusal');
        expect(banner).toHaveAttribute('data-kind', 'run_stopped');
        expect(banner.textContent).not.toMatch(/Nothing was tested/);
        expect(banner.textContent).toMatch(/stopped part-way/);
    });
});

describe('BIJT — een geweigerde lezing is geen storing', () => {
    it('403 op de vragen komt als weigering, zonder Opnieuw-knop', () => {
        render(
            <TestSetCard {...base} tests={[]} testsState={READ.ERROR}
                readRefusal={refusalFor({ status: 403, body: { code: 'agent_not_editable' } })}
                onRetryTests={() => {}} />,
        );
        const banner = screen.getByTestId('agent-tests-refusal');
        expect(banner).toHaveAttribute('data-kind', 'not_editable');
        expect(banner.textContent).toMatch(/edit access/);
        expect(screen.queryByTestId('agent-tests-unreadable')).toBeNull();
        expect(screen.queryByTestId('agent-tests-refusal-retry')).toBeNull();
    });

    it('een netwerkfout blijft de gele "kon niet laden", mét Opnieuw', () => {
        render(<TestSetCard {...base} tests={[]} testsState={READ.ERROR} onRetryTests={() => {}} />);
        expect(screen.getByTestId('agent-tests-unreadable')).toBeTruthy();
    });
});

describe('BIJT — waar de score OVER gaat, en wie de vraag schreef', () => {
    it('"about v3" komt uit de run, niet uit de lucht', () => {
        render(<TestSetCard {...base} lastRun={run()} />);
        expect(screen.getByTestId('agent-tests-about').textContent).toMatch(/about v3/);
    });

    it('een run op het CONCEPT zegt dat, en noemt geen versie', () => {
        const draftRun = run({ version: 0, results: { ...run().results, source: 'live' } });
        render(<TestSetCard {...base} lastRun={draftRun} />);
        const about = screen.getByTestId('agent-tests-about');
        expect(about.textContent).toMatch(/about your draft/);
        expect(about.textContent).not.toMatch(/about v/);
    });

    it('een verwachting die een model opschreef draagt dat merkje ook na het opslaan', () => {
        const list = tests(2);
        list[0] = { ...list[0], writtenBy: { mustMention: 'ai', notes: 'human' } };
        render(<TestSetCard {...base} tests={list} lastRun={run()} />);
        fireEvent.click(screen.getByTestId('agent-tests-view'));
        expect(screen.getAllByTestId('agent-tests-question-ai')).toHaveLength(1);
    });

    it('een vraag die iemand zelf tikte draagt er geen', () => {
        render(<TestSetCard {...base} tests={tests(2)} lastRun={run()} />);
        fireEvent.click(screen.getByTestId('agent-tests-view'));
        expect(screen.queryByTestId('agent-tests-question-ai')).toBeNull();
    });
});

describe('BIJT — een historierij spreekt over zichzelf', () => {
    it('noemt zich niet "The last run"', () => {
        const rows = [
            { id: 'r9', version: 4, passed: 5, total: 0, ranAt: RAN_AT, results: {} },
            { id: 'r8', version: 3, passed: 11, total: 12, ranAt: RAN_AT, results: { items: Array.from({ length: 12 }, () => item()) } },
        ];
        render(<TestSetCard {...base} lastRun={run()} runs={rows} runsKeep={20} />);
        fireEvent.click(screen.getByTestId('agent-tests-view'));
        const [first] = screen.getAllByTestId('agent-tests-run-row');
        expect(first).toHaveAttribute('data-state', 'unfinished');
        expect(first.textContent).toMatch(/This run did not finish/);
        expect(first.textContent).not.toMatch(/The last run/);
        expect(first.textContent).not.toMatch(/5 of 0/);
        expect(first.textContent).not.toMatch(/null/);
    });
});
