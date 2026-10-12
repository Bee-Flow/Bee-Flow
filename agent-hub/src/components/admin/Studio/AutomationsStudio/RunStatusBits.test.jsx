import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { DryRunBadge, RunStatusBadge, RunStatusIcon } from './RunStatusBits';
import { STATUS_TOKENS } from '../../../shared/statusTokens';

/**
 * The two primitives every run surface paints with — the runs table, the run
 * bar, the step list. What is pinned here is that they read the shared table
 * and nothing else: the old bug was `awaiting_approval` falling through to a
 * grey "queued" Play icon, and the same shape of bug is what made `running`
 * and `paused` one amber.
 */

describe('RunStatusIcon', () => {
    beforeEach(cleanup);

    it('spins for a running run and does not for a paused one', () => {
        const { container } = render(<><RunStatusIcon status="running" /><RunStatusIcon status="paused" /></>);
        const [running, paused] = [...container.querySelectorAll('[data-status-key]')];
        expect(running.getAttribute('data-status-key')).toBe('run_status.running');
        expect(running.getAttribute('class')).toContain('animate-spin');
        expect(paused.getAttribute('data-status-key')).toBe('run_status.paused');
        expect(paused.getAttribute('class')).not.toContain('animate-spin');
        expect(running.getAttribute('class')).toContain(STATUS_TOKENS.running.solid);
        expect(paused.getAttribute('class')).toContain(STATUS_TOKENS.paused.solid);
    });

    it('follows the server aliases instead of degrading them to idle', () => {
        const { container } = render(<RunStatusIcon status="awaiting_confirm" />);
        expect(container.querySelector('[data-status-key]').getAttribute('data-status-key'))
            .toBe('run_status.awaiting_approval');
    });

    it('tells the two kinds of skip apart when it is given the whole row', () => {
        const { container } = render(
            <>
                <RunStatusIcon status="skipped" step={{ status: 'skipped', output: { disabled: true } }} />
                <RunStatusIcon status="skipped" step={{ status: 'skipped', output: { skipped: 'nothing to write' } }} />
            </>,
        );
        const [off, empty] = [...container.querySelectorAll('[data-status-key]')];
        expect(off.getAttribute('data-status-key')).toBe('run_status.skipped');
        expect(empty.getAttribute('data-status-key')).toBe('run_status.nothing_to_do');
        expect(off.getAttribute('class')).not.toBe(empty.getAttribute('class'));
    });
});

describe('RunStatusBadge', () => {
    beforeEach(cleanup);

    it('renders the word from the dictionary, keyed by the token', () => {
        render(<RunStatusBadge status="success" />);
        const badge = screen.getByTestId('run-status-badge');
        expect(badge.getAttribute('data-status-key')).toBe('run_status.success');
        expect(badge.textContent).toBe('Finished');
    });

    it('gives a running run and a paused run different words and different chips', () => {
        const { container } = render(<><RunStatusBadge status="running" /><RunStatusBadge status="paused" /></>);
        const [running, paused] = [...container.querySelectorAll('[data-testid="run-status-badge"]')];
        expect(running.textContent).toBe('Running');
        expect(paused.textContent).toBe('Paused');
        expect(running.getAttribute('class')).not.toBe(paused.getAttribute('class'));
    });

    it('says "Nothing to do" for a step that ran and found nothing', () => {
        render(<RunStatusBadge status="skipped" step={{ status: 'skipped', output: { skipped: 'the summary came back empty' } }} />);
        expect(screen.getByTestId('run-status-badge').textContent).toBe('Nothing to do');
    });
});

describe('DryRunBadge', () => {
    beforeEach(cleanup);

    it('is a separate mark, so a test run shows BOTH facts', () => {
        render(<><RunStatusBadge status="success" /><DryRunBadge /></>);
        expect(screen.getByTestId('run-status-badge').textContent).toBe('Finished');
        expect(screen.getByText('dry-run')).toBeTruthy();
    });
});
