import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ListView from './ListView';
import { STATUS_TOKENS } from '../shared/statusTokens';

/**
 * The routine cards. Like Cowork, this list runs a SCHEDULE's `lastStatus`
 * through the run-status table, so it inherited the same confusion: a card
 * running right now and a card whose last run was paused wore one amber chip.
 * The chip now says a different word in a different colour, and the word
 * comes from the dictionary rather than from the module.
 */

const task = (over = {}) => ({
    id: 't1',
    title: 'Weekly digest',
    prompt: 'Summarise the week',
    isActive: true,
    lastStatus: 'success',
    modelTier: 'auto',
    runCount: 2,
    lastRunAt: new Date().toISOString(),
    ...over,
});

function renderList(tasks) {
    return render(
        <ListView
            loading={false}
            activeTasks={tasks}
            inactiveTasks={[]}
            modelTiers={{}}
            onEdit={vi.fn()}
            onToggle={vi.fn()}
            onRequestDelete={vi.fn()}
            onRunNow={vi.fn()}
            onOpenResult={vi.fn()}
            onCreate={vi.fn()}
            canCreate
        />,
    );
}

describe('ListView — the status chip', () => {
    beforeEach(cleanup);

    it('names the status in the dictionary\'s words', () => {
        renderList([task({ lastStatus: 'success' })]);
        const chip = screen.getByTestId('task-status');
        expect(chip.getAttribute('data-status-key')).toBe('run_status.success');
        expect(chip.textContent).toContain('Finished');
    });

    it('separates a running card from a paused one', () => {
        renderList([task({ id: 't1', lastStatus: 'running' }), task({ id: 't2', lastStatus: 'paused' })]);
        const [running, paused] = screen.getAllByTestId('task-status');
        expect(running.getAttribute('data-status-key')).toBe('run_status.running');
        expect(paused.getAttribute('data-status-key')).toBe('run_status.paused');
        expect(running.textContent).toContain('Running');
        expect(paused.textContent).toContain('Paused');
        expect(running.getAttribute('class')).toContain(STATUS_TOKENS.running.badge);
        expect(paused.getAttribute('class')).toContain(STATUS_TOKENS.paused.badge);
        expect(running.getAttribute('class')).not.toBe(paused.getAttribute('class'));
    });

    it('keeps the card readable for a status it has never heard of', () => {
        renderList([task({ lastStatus: 'weird_future_status' })]);
        expect(screen.getByTestId('task-status').getAttribute('data-status-key')).toBe('run_status.idle');
        expect(screen.getByText('Weekly digest')).toBeTruthy();
    });
});
