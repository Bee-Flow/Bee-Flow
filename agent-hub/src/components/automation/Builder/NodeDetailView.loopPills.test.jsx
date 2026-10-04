import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

// NDV fetches the tool catalog on mount — stub the API.
const { api } = vi.hoisted(() => ({
    api: { getCatalog: vi.fn().mockResolvedValue({ apps: [], triggerOutputs: {} }) },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

// A switchable dictionary over the REAL useTranslation. Off by default (every
// other test in this file reads the shipped English), and switched on by the
// footer test below so it can prove the words come from t() rather than
// happening to be English in the source. Without this a hardcoded "In" would
// still match a t('automations.ndv.in') that falls back to "In".
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

import NodeDetailView, { resolveInSummary, resolveLoopContext } from './NodeDetailView';
import { composeInlineGraph } from './flow/inlineFlowlets';

/**
 * The three pills that make a claim about a LOOP, and the one function all of
 * them read.
 *
 * Why this file exists: "1 of 4" (Incoming), "runs 4× · one per <list>"
 * (Settings header) and the drawer footer's "In … → Out …" shipped with zero
 * test references. Each is a sentence the screen asserts about data — and this
 * product's rule is that a screen may not claim what it cannot substantiate.
 * The count comes from the LAST RUN's loop row and from nowhere else, so the
 * interesting cases here are the REFUSALS: no run, an empty run row, a loop
 * whose row is missing. All of those must show nothing rather than guess.
 */

// ── the pure function ──────────────────────────────────────────────────────

const loopGroup = (over = {}) => ({ id: 'lp1', label: 'Per bank', basePath: 'loop.invoice', fields: [], ...over });
const plainGroup = { id: 's1', label: 'Gmail search', basePath: 'steps.s1.output', fields: [] };
const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'lp1', type: 'loop', label: 'Per bank', overRef: 'steps.src.output.results', itemVar: 'invoice', body: [] }],
    edges: [],
};
const runRow = (output) => [{ stepId: 'lp1', output }];

describe('resolveLoopContext', () => {
    it('is null when no group is a loop item — an ordinary step claims nothing', () => {
        expect(resolveLoopContext({ groups: [plainGroup], definition: DEF, runSteps: runRow({ iterations: 4 }) })).toBe(null);
    });

    it('is null when there has been no run at all', () => {
        // THE refusal. Without a run the total would be a guess about a list
        // nobody has fetched — and "1 of 4" is not a guess-shaped sentence.
        expect(resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: [] })).toBe(null);
    });

    it('is null when the run row exists but counted nothing', () => {
        // A loop that ran over an empty list. `{ iterations: 0 }` is evidence
        // that there were zero items, and "1 of 0" is not a thing to say.
        expect(resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: runRow({ iterations: 0, results: [] }) })).toBe(null);
    });

    it('is null when a run row for a DIFFERENT step is the only one present', () => {
        const other = [{ stepId: 'lp2', output: { iterations: 9 } }];
        expect(resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: other })).toBe(null);
    });

    it('is null when the row carries no output at all (still running)', () => {
        expect(resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: [{ stepId: 'lp1' }] })).toBe(null);
    });

    it('reads the total off the last run and pins the index at 1', () => {
        // 1, not "the current one": the sample the drawer resolves against is
        // the FIRST item, so any other number would name an iteration this
        // panel is not showing.
        const ctx = resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: runRow({ iterations: 4, totalItems: 4 }) });
        expect(ctx.iteration).toEqual({ index: 1, total: 4, truncated: false, skipped: 0 });
        expect(ctx.runs).toBe(4);
        expect(ctx.listLabel).toBe('Per bank');
    });

    it('prefers totalItems for the count and iterations for the run count', () => {
        // A capped loop: 100 rows, maxIterations stopped it at 10. "1 of 100"
        // and "runs 10×" are both true and they are different numbers.
        const ctx = resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: runRow({ iterations: 10, totalItems: 100 }) });
        expect(ctx.iteration.total).toBe(100);
        expect(ctx.runs).toBe(10);
    });

    it('carries the CAP, not just the two numbers it produced', () => {
        // execFlow writes `totalItems` in exactly one place: next to
        // `truncated: true`, when maxIterations stopped the loop and the tail
        // was dropped. Reading the total and dropping the flag is how "1 of
        // 100" ended up on screen for a run that processed ten — two true
        // numbers, in two different columns, with nothing saying the other 90
        // never happened. The flag rides along with the number it qualifies.
        const ctx = resolveLoopContext({
            groups: [loopGroup()], definition: DEF,
            runSteps: runRow({ iterations: 10, totalItems: 100, truncated: true }),
        });
        expect(ctx.truncated).toBe(true);
        expect(ctx.skipped).toBe(90);
        expect(ctx.iteration).toEqual({ index: 1, total: 100, truncated: true, skipped: 90 });
    });

    it('claims no cap when the run row does not claim one', () => {
        // The ordinary loop: everything it was given, it ran. `skipped: 0` and
        // `truncated: false` are the honest answer — a warning here would be
        // as wrong as its absence above.
        const ctx = resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: runRow({ iterations: 4, totalItems: 4 }) });
        expect(ctx.truncated).toBe(false);
        expect(ctx.skipped).toBe(0);
    });

    it('falls back to the length of results when neither count is written', () => {
        const ctx = resolveLoopContext({ groups: [loopGroup()], definition: DEF, runSteps: runRow({ results: [1, 2, 3] }) });
        expect(ctx.iteration.total).toBe(3);
        expect(ctx.runs).toBe(3);
    });

    it('strips upstream\'s __foreach suffix before looking the loop step up', () => {
        const ctx = resolveLoopContext({
            groups: [loopGroup({ id: 'lp1__foreach' })],
            definition: DEF,
            runSteps: runRow({ iterations: 2 }),
        });
        expect(ctx.runs).toBe(2);
        expect(ctx.listLabel).toBe('Per bank');
    });

    it('never names the synthetic entry pill as the list — that is chrome, not a list', () => {
        // On an expanded loop the group id IS a step in the flat graph:
        // `lp1/__item__`, type loop_item, label "Each item". Reading its label
        // made the pill say "one per Each item" where the artboard says "one
        // per bank".
        const flatish = {
            steps: [
                { id: 'lp1/__item__', type: 'loop_item', label: 'Each item' },
                { id: 'lp1', type: 'loop', label: 'Per bank' },
            ],
        };
        const ctx = resolveLoopContext({
            groups: [loopGroup({ id: 'lp1/__item__', label: 'Each item' })],
            definition: flatish,
            stepId: 'lp1/b',
            runSteps: runRow({ iterations: 2 }),
        });
        expect(ctx.listLabel).toBe('Per bank');
    });

    it('finds the loop from the inline prefix when the group is the synthetic __loop_item', () => {
        // An EXPANDED loop body: the edited step is `lp1/b`, and its group is
        // the synthetic entry node, so the loop id only exists in the prefix.
        const ctx = resolveLoopContext({
            groups: [loopGroup({ id: '__loop_item', label: 'Each item' })],
            definition: DEF,
            stepId: 'lp1/b',
            runSteps: runRow({ iterations: 4 }),
        });
        expect(ctx.runs).toBe(4);
        expect(ctx.listLabel).toBe('Per bank');
    });

    it('falls back to the GROUP label when the loop step has no label of its own', () => {
        const unlabelled = { ...DEF, steps: [{ ...DEF.steps[0], label: '' }] };
        const ctx = resolveLoopContext({
            groups: [loopGroup({ label: 'Current item (loop.invoice)' })],
            definition: unlabelled,
            runSteps: runRow({ iterations: 2 }),
        });
        expect(ctx.listLabel).toBe('Current item (loop.invoice)');
    });

    it('looks in rootDefinition too — an expanded body is not in `definition`', () => {
        const ctx = resolveLoopContext({
            groups: [loopGroup({ id: '__loop_item' })],
            definition: { steps: [] },
            rootDefinition: DEF,
            stepId: 'lp1/b',
            runSteps: runRow({ iterations: 7 }),
        });
        expect(ctx.listLabel).toBe('Per bank');
        expect(ctx.runs).toBe(7);
    });

    it('survives being handed nothing at all', () => {
        expect(resolveLoopContext({})).toBe(null);
    });
});

// ── the pills that read it ─────────────────────────────────────────────────

const CATALOG = { apps: [], triggerOutputs: {} };
const LOOP_DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
    steps: [
        {
            id: 'lp1', type: 'loop', label: 'Per bank',
            overRef: 'trigger.output.banks', itemVar: 'bank',
            position: { x: 200, y: 0 },
            body: [{ id: 'b', type: 'set', label: 'Body step', fields: {} }],
        },
    ],
    edges: [{ from: 'trg', to: 'lp1' }],
};
const FLAT = composeInlineGraph(LOOP_DEF, LOOP_DEF, new Set(['lp1'])).graph;
const BODY = FLAT.steps.find(s => s.id === 'lp1/b');

// `extra` is how a test picks the DENSITY: the drawer draws the same footer
// line in the small dialog (density="quick") and in the full drawer, so both
// halves are reachable through one helper.
const renderBody = (runSteps = [], extra = {}) => render(
    <NodeDetailView
        step={BODY}
        runStep={null}
        runSteps={runSteps}
        definition={FLAT}
        rootDefinition={LOOP_DEF}
        onSaveStep={vi.fn().mockResolvedValue(undefined)}
        validation={{ errors: [], warnings: [] }}
        modelTiers={{}}
        catalog={CATALOG}
        onExecuteStep={vi.fn()}
        onRetryFromStep={vi.fn()}
        onClose={vi.fn()}
        {...extra}
    />,
);

describe('the loop pills in the drawer', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; try { localStorage.clear(); } catch { /* ignore */ } });

    it('shows NO runs pill and NO iteration pill before the automation has run', () => {
        renderBody([]);
        expect(screen.queryByTestId('ndv-runs-pill')).toBeNull();
        expect(screen.queryByTestId('input-loop-iteration')).toBeNull();
    });

    it('says "runs 2× · one per Per bank" on the Settings header after a run', () => {
        renderBody([{ stepId: 'lp1', output: { iterations: 2, totalItems: 2 } }]);
        expect(screen.getByTestId('ndv-runs-pill').textContent).toBe('runs 2× · one per Per bank');
    });

    it('the two pills cannot contradict each other — both quote the same total', () => {
        // They are two readings of ONE resolveLoopContext call. A regression
        // that gave either its own source would show up as "1 of 3" beside
        // "runs 2×", and nobody would know which to believe.
        renderBody([{ stepId: 'lp1', output: { iterations: 3, totalItems: 3 } }]);
        expect(screen.getByTestId('ndv-runs-pill').textContent).toContain('3');
        expect(screen.getByTestId('input-loop-iteration').textContent).toBe('1 of 3');
    });

    it('draws the drawer footer\'s In → Out line, and says "not run yet" rather than nothing', () => {
        renderBody([]);
        const foot = screen.getByTestId('ndv-footer-inout');
        expect(foot.textContent).toContain('In');
        expect(foot.textContent).toContain('Out');
        // The refusal shape again: an unrun step has no output, and the footer
        // says so in words instead of leaving an empty slot that reads as "no
        // fields".
        expect(foot.textContent).toContain('not run yet');
    });

    it('draws that SAME line in the small dialog — word for word, not a second English copy', () => {
        // One sentence, two densities. The small dialog wraps it in a button
        // (it opens the full drawer); the full drawer states it. Nothing about
        // the WORDS may differ, and for a while they did: the quick half had
        // "In", "Out" and "not run yet" hardcoded, so a Dutch Builder read
        // Dutch in one footer and English in the other.
        //
        // The dictionary is swapped first, which is what makes this bite: with
        // the shipped English a hardcoded "In" is indistinguishable from
        // t('automations.ndv.in'). These three values can only appear on screen
        // if both halves went through t().
        transOverride.current = {
            'automations.ndv.in': 'INGAAND',
            'automations.ndv.out': 'UITGAAND',
            'automations.ndv.not_run_yet': 'nog niet gedraaid',
        };
        renderBody([], { density: 'full' });
        const full = screen.getByTestId('ndv-footer-inout').textContent;
        cleanup();
        renderBody([], { density: 'quick' });
        const quick = screen.getByTestId('ndv-footer-inout').textContent;

        expect(quick).toBe(full);
        expect(quick).toContain('INGAAND');
        expect(quick).toContain('UITGAAND');
        expect(quick).toContain('nog niet gedraaid');
    });

    it('says nothing on the Incoming header when there is no sample to summarise', () => {
        // The refusal again: "1 record" is a claim about data. With no run and
        // no pin there is nothing to count, so the pill is absent rather than
        // showing a zero or a guess.
        renderBody([]);
        expect(screen.queryByTestId('ndv-in-summary-pill')).toBeNull();
    });

    it('says "1 record" on the Incoming header once real data arrives (artboard 2a)', () => {
        renderBody([
            { stepId: 'trg', output: { banks: [{ name: 'ING' }, { name: 'ABN' }] } },
            { stepId: 'lp1', output: { iterations: 2, totalItems: 2 } },
        ]);
        expect(screen.getByTestId('ndv-in-summary-pill').textContent.trim()).toBe('1 record');
    });
});


describe('the iteration pill when the loop was cut short', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; try { localStorage.clear(); } catch { /* ignore */ } });

    it('says how many were left out, in the same breath as the total', () => {
        // 100 invoices, maxIterations 10. Without this the pill read "1 of
        // 100" — literally true about which item the sample is, and read by
        // everyone as "this loop covers 100 records". The run count sits in
        // the Settings column, a panel away, with no sentence joining them.
        renderBody([{ stepId: 'lp1', output: { iterations: 10, totalItems: 100, truncated: true } }]);
        expect(screen.getByTestId('input-loop-iteration').textContent).toBe('1 of 100 · 90 not processed');
    });

    it('leaves an uncapped loop exactly as it was', () => {
        renderBody([{ stepId: 'lp1', output: { iterations: 3, totalItems: 3 } }]);
        expect(screen.getByTestId('input-loop-iteration').textContent).toBe('1 of 3');
    });

    it('the whole phrase goes through t(), the skipped count included', () => {
        transOverride.current = { 'automations.mapping.iteration_of_capped': '{n} van {total} · {skipped} overgeslagen' };
        renderBody([{ stepId: 'lp1', output: { iterations: 10, totalItems: 100, truncated: true } }]);
        expect(screen.getByTestId('input-loop-iteration').textContent).toBe('1 van 100 · 90 overgeslagen');
    });
});

/**
 * The Incoming header's "1 record", as a rule rather than a render.
 *
 * The thing being pinned is a REFUSAL, and refusals are cheapest to state on
 * the pure function: a count is a claim about data that was fetched, and the
 * merged sample root the drawer resolves against is built out of the catalog's
 * curated design samples. Those are for placeholders, not for counting.
 */
describe('resolveInSummary', () => {
    const real = { id: 's1', label: 'Gmail search', basePath: 'steps.s1.output', hasRealData: true, sample: { results: [{ id: 1 }, { id: 2 }] } };
    const drawn = { ...real, hasRealData: false };
    const root = { steps: { s1: { output: { results: [{ id: 1 }, { id: 2 }] } } } };

    it('counts what a run actually produced', () => {
        expect(resolveInSummary({ groups: [real], previewSample: root })?.label).toBe('2 records');
    });

    it('says NOTHING about a shape nobody has run', () => {
        // The bug in one line: this group's sample is the catalog's
        // `outputSample` — two invented mails, served so the variable tree has
        // realistic placeholders without a dry run. Counting it produced
        // "In 2 records → Out not run yet": one half refusing to guess, the
        // other half guessing, in one sentence.
        expect(resolveInSummary({ groups: [drawn], previewSample: root })).toBe(null);
    });

    it('accepts the loop item, but only once the loop itself has a run', () => {
        // The loop's "current item" is never overlaid — its sample is DERIVED
        // from the list the loop ran over. `loopContext` is non-null only when
        // that loop has a row in the last run, so it is the same evidence one
        // step removed. Without it, silence.
        const item = { id: '__loop_item', label: 'Current item', basePath: 'loop.bank', sample: { name: 'ING' } };
        const sampleRoot = { loop: { bank: { name: 'ING' } } };
        expect(resolveInSummary({ groups: [item], previewSample: sampleRoot })).toBe(null);
        expect(resolveInSummary({ groups: [item], previewSample: sampleRoot, loopContext: { runs: 2 } })?.label).toBe('1 record');
    });

    it('reads the NEAREST group, not any group that happens to have run', () => {
        // A run that stopped halfway leaves an early step real and the step
        // just above this one still drawn. The claim is about what arrives
        // HERE, so the last group is the only one that may make it.
        expect(resolveInSummary({ groups: [real, drawn], previewSample: root })).toBe(null);
    });

    it('survives being handed nothing at all', () => {
        expect(resolveInSummary()).toBe(null);
        expect(resolveInSummary({ groups: [] })).toBe(null);
    });
});
