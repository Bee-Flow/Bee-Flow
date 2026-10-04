import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import SolutionControlPanel, { isBlocking } from './SolutionControlPanel';

/**
 * The Check panel, and the rule the publish button hangs on.
 *
 * An empty findings list is what a clean Solution looks like AND what a failed
 * request looks like. Every test below exists to keep those two apart, because
 * confusing them publishes a broken Solution and tells the person it was fine.
 */

const CLEAN = { findings: [], blocked: false, complete: true, unavailable: [] };

const BLOCKER = {
    code: 'cross_owner', severity: 'error', kind: 'app',
    targetRef: { kind: 'app', id: 'app1', title: 'Desk' },
    message: 'Desk runs an automation owned by someone else.',
    remediation: 'Both must belong to the same person.',
    deepLink: '/app/studio/apps/app1',
};

const ADVICE = {
    code: 'ai_step.prompt_missing', severity: 'warning', blockedAt: 'activate', kind: 'automation',
    targetRef: { kind: 'automation', id: 'a1', title: 'Nightly' },
    message: 'Step s1: ai_step requires `prompt`.',
    deepLink: '/app/studio/automations/a1',
};

const NO_LINK = {
    code: 'component.control_inert', severity: 'warning', kind: 'app',
    targetRef: { kind: 'app', id: null },
    message: 'This button is wired to nothing.',
    deepLink: null,
};

describe('the three ways of knowing nothing', () => {
    it('a failed request says the checks did not run — never "nothing to fix"', () => {
        const { getByTestId, queryByTestId } = render(
            <SolutionControlPanel completeness={null} loading={false} error />,
        );
        expect(getByTestId('solution-control-unreachable')).toBeTruthy();
        expect(queryByTestId('solution-control-clear')).toBeNull();
    });

    it('no answer at all is treated the same as a failure', () => {
        const { getByTestId } = render(<SolutionControlPanel completeness={null} loading={false} />);
        expect(getByTestId('solution-control-unreachable')).toBeTruthy();
    });

    it('an answer that could not read the whole Solution says so, and names the gaps', () => {
        const { getByTestId, getByText, queryByTestId } = render(
            <SolutionControlPanel
                completeness={{ findings: [], blocked: true, complete: false, unavailable: ['agents', 'apps'] }}
                loading={false}
            />,
        );
        expect(getByTestId('solution-control-incomplete')).toBeTruthy();
        expect(getByText('agents, apps')).toBeTruthy();
        expect(queryByTestId('solution-control-clear')).toBeNull();
    });

    it('ONLY a complete answer with no findings gets the reassuring sentence', () => {
        const { getByTestId } = render(<SolutionControlPanel completeness={CLEAN} loading={false} />);
        expect(getByTestId('solution-control-clear')).toBeTruthy();
    });

    it('while loading it shows neither verdict', () => {
        const { queryByTestId } = render(<SolutionControlPanel completeness={null} loading />);
        expect(queryByTestId('solution-control-clear')).toBeNull();
        expect(queryByTestId('solution-control-unreachable')).toBeNull();
    });
});

describe('blocking versus advice', () => {
    it('an error goes under "has to be fixed first"', () => {
        const { getByText } = render(
            <SolutionControlPanel completeness={{ ...CLEAN, blocked: true, findings: [BLOCKER] }} loading={false} />,
        );
        expect(getByText('Has to be fixed first')).toBeTruthy();
        expect(getByText('Desk runs an automation owned by someone else.')).toBeTruthy();
    });

    it('a draft automation\'s completeness code is advice, and says what it does block', () => {
        const { getByText, queryByText } = render(
            <SolutionControlPanel completeness={{ ...CLEAN, findings: [ADVICE] }} loading={false} />,
        );
        expect(getByText('Worth a look')).toBeTruthy();
        expect(queryByText('Has to be fixed first')).toBeNull();
        expect(getByText(/blocks turning it on/)).toBeTruthy();
    });

    it('advice alone is stated as not standing in the way of a release', () => {
        const { getByTestId } = render(
            <SolutionControlPanel completeness={{ ...CLEAN, findings: [ADVICE] }} loading={false} />,
        );
        expect(getByTestId('solution-control-releasable')).toBeTruthy();
    });

    it('isBlocking is the gate\'s rule: errors, and anything tagged blockedAt publish', () => {
        expect(isBlocking(BLOCKER)).toBe(true);
        expect(isBlocking(ADVICE)).toBe(false);
        expect(isBlocking({ severity: 'warning', blockedAt: 'publish' })).toBe(true);
        expect(isBlocking(null)).toBe(false);
    });
});

describe('show me', () => {
    it('opens where the server said to go', () => {
        const onOpen = vi.fn();
        const { getByTestId } = render(
            <SolutionControlPanel completeness={{ ...CLEAN, findings: [BLOCKER] }} loading={false} onOpen={onOpen} />,
        );
        fireEvent.click(getByTestId('solution-finding-open'));
        expect(onOpen).toHaveBeenCalledWith('/app/studio/apps/app1');
    });

    it('a finding the server could not place gets NO link rather than one to nowhere', () => {
        const { queryByTestId, getByText } = render(
            <SolutionControlPanel completeness={{ ...CLEAN, findings: [NO_LINK] }} loading={false} />,
        );
        expect(getByText('This button is wired to nothing.')).toBeTruthy();
        expect(queryByTestId('solution-finding-open')).toBeNull();
    });
});
