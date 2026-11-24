// The steps of a run that followed a plan, inside the opened run of the history. The view takes the trace as a prop,
// so nothing is mocked; a run that followed no plan mounts nothing (and so needs no query client).
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CoworkRunTrace, { RunTraceView } from './CoworkRunTrace';
import { englishT as t, supplierRadarTry } from './coworkPlan.fixture';
import type { PlanRunTrace } from '@/api/coworkPlan.types';

/** A real run of "Supplier radar": the same steps, and nothing was held back. */
function realRun(over: Partial<PlanRunTrace> = {}): PlanRunTrace {
    const steps = supplierRadarTry().steps.map((s) => ({ ...s, held: false }));
    return { runId: 'run-1', planVersion: 2, recorded: true, done: true, durationMs: 5200, steps, ...over };
}

describe('RunTraceView', () => {
    it('says which version of the plan the run followed, and lists its steps in order', () => {
        render(<RunTraceView trace={realRun()} t={t} />);
        const block = screen.getByTestId('cowork-run-trace');
        expect(block.textContent).toContain('Followed the plan, version 2');
        expect(within(block).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual([
            'cowork-plan-try-step-mail', 'cowork-plan-try-step-orders', 'cowork-plan-try-step-overdue', 'cowork-plan-try-step-table',
            'cowork-plan-try-step-reply', 'cowork-plan-try-step-draft', 'cowork-plan-try-step-digest',
        ]);
    });

    it('a real run held nothing back: a step that wrote or sent says what it changed or sent', () => {
        render(<RunTraceView trace={realRun()} t={t} />);
        expect(screen.queryByText('Held back')).toBeNull();
        expect(within(screen.getByTestId('cowork-plan-try-step-table')).getByText('What it changed')).toBeTruthy();
        expect(within(screen.getByTestId('cowork-plan-try-step-digest')).getByText('What it sent')).toBeTruthy();
        expect(within(screen.getByTestId('cowork-plan-try-step-mail')).getByText('What it got')).toBeTruthy();
        expect(screen.queryByText(/would have/)).toBeNull();
    });

    it('shows the step that failed with its reason, and the steps the run never reached', () => {
        const trace = realRun();
        trace.steps = trace.steps.map((s, i) => (i === 3 ? { ...s, status: 'error', error: 'The table is gone.', preview: null } : i > 3 ? { ...s, status: 'not_reached', preview: null, durationMs: null } : s));
        render(<RunTraceView trace={trace} t={t} />);
        const failed = screen.getByTestId('cowork-plan-try-step-table');
        expect([failed.getAttribute('data-tone'), failed.textContent?.includes('The table is gone.')]).toEqual(['failed', true]);
        expect(screen.getByTestId('cowork-plan-try-step-digest').getAttribute('data-tone')).toBe('skipped');
    });

    it('names each step by its plain title, never by its id or tool name, and keeps the raw data under Details', () => {
        const trace = realRun();
        trace.steps = trace.steps.map((s, i) => (i === 0 ? { ...s, title: 'a_b858bb' } : i === 1 ? { ...s, title: 'outlook_create_draft' } : s));
        render(<RunTraceView trace={trace} t={t} />);
        const block = screen.getByTestId('cowork-run-trace');
        const titles = within(block).getAllByRole('listitem').map((li) => li.querySelector('span[class*="text-[13px]"]')?.textContent);
        expect(titles.slice(0, 2)).toEqual(['A fixed step', 'Outlook create draft']);
        expect(block.textContent).not.toContain('a_b858bb');
        expect(block.textContent).not.toContain('outlook_create_draft');
        // What a step got is one level deeper: a closed "Details", with its label and the data inside it.
        for (const details of within(block).getAllByTestId('cowork-step-details')) {
            expect(details).not.toHaveAttribute('open');
            expect(details.querySelector('summary')?.textContent).toBe('Details');
            expect(details.querySelector('pre')).not.toBeNull();
        }
        expect(within(screen.getByTestId('cowork-plan-try-step-mail')).getByText('What it got').closest('details')).not.toBeNull();
    });

    it('says so when the steps were not recorded or are no longer kept, and lists no made-up outcome', () => {
        render(<RunTraceView trace={realRun({ recorded: false })} t={t} />);
        expect(screen.getByTestId('cowork-run-trace-not-recorded').textContent).toContain('no longer kept');
        expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    });
});

describe('CoworkRunTrace', () => {
    it('shows nothing for a run that followed no plan', () => {
        const { container } = render(<CoworkRunTrace coworkId="cw-1" run={{ id: 'run-1', status: 'success', startedAt: '2026-11-23T08:00:00.000Z' }} t={t} />);
        expect(container.textContent).toBe('');
    });
});
