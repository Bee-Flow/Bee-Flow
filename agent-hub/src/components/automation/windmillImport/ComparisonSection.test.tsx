import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithClient } from '@/test/render';
import type { ImportComparison } from '@/api/windmillImport';
import ComparisonSection from './ComparisonSection';

/**
 * The "Comparison" section of the import report: per Windmill run whether the
 * dry run reached the end, the failed steps with their code, the shape
 * differences as key paths, and whether it was kept as a golden run; a flow
 * that was not compared says why in one sentence.
 */

const DONE: ImportComparison = {
    at: '2026-11-15T10:00:00.000Z', requested: 5, status: 'done', savedAsTests: true,
    scenarios: [
        {
            windmillRunId: '018f6a2e-aaaa', windmillSuccess: true, status: 'success', reachedEnd: true, failedSteps: [],
            shapeDiffs: [{ stepId: 'vat_1a2b', wmId: 'vat', simulated: true, missing: ['currency', 'owner'], extra: ['rounded'] }],
            saved: { golden: true, runId: 'run-1', reason: null },
        },
        {
            windmillRunId: '018f6a2e-bbbb', windmillSuccess: false, status: 'error', reachedEnd: false,
            failedSteps: [{ stepId: 'post_9c', code: 'integration_auth_missing' }], shapeDiffs: [],
            saved: { golden: false, runId: null, reason: 'golden_needs_success' },
        },
    ],
};

describe('ComparisonSection', () => {
    it('lists each run with its status, failed steps, shape differences and what was kept', () => {
        renderWithClient(<ComparisonSection comparison={DONE} />);
        expect(screen.getByRole('region', { name: 'Comparison with the last Windmill runs' })).toBeInTheDocument();
        expect(screen.getByText('1 of 2 dry runs reached the end')).toBeInTheDocument();
        expect(screen.getByText('Reached the end')).toBeInTheDocument();
        expect(screen.getByText('Did not reach the end')).toBeInTheDocument();
        expect(screen.getByText('Windmill run 018f6a2e-aaaa')).toBeInTheDocument();
        expect(screen.getByText('(this run failed in Windmill too)')).toBeInTheDocument();
        expect(screen.getByText('Step post_9c failed: integration_auth_missing')).toBeInTheDocument();
        expect(screen.getByText('Step vat_1a2b gives a result with a different shape')).toBeInTheDocument();
        expect(screen.getByText('(simulated in a dry run)')).toBeInTheDocument();
        expect(screen.getByText('Missing in Bee Flow: currency, owner')).toBeInTheDocument();
        expect(screen.getByText('Only in Bee Flow: rounded')).toBeInTheDocument();
        expect(screen.getByText('Kept as a golden run')).toBeInTheDocument();
        expect(screen.getByText(/Not kept: only a dry run that reached the end/)).toBeInTheDocument();
        expect(screen.getByText(/Only this summary is kept/)).toBeInTheDocument();
    });

    it('a flow that was not compared says why', () => {
        const { unmount } = renderWithClient(<ComparisonSection comparison={{ ...DONE, status: 'unauthorized', scenarios: [] }} />);
        expect(screen.getByText('Not compared: the token may not read the runs of this workspace.')).toBeInTheDocument();
        expect(screen.queryByText(/dry runs reached the end/)).not.toBeInTheDocument();
        unmount();
        renderWithClient(<ComparisonSection comparison={{ ...DONE, status: 'no_runs', scenarios: [] }} />);
        expect(screen.getByText(/Windmill has no finished runs of this flow/)).toBeInTheDocument();
    });
});
