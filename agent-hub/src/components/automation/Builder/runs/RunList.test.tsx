import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import RunList from './RunList';
import { withQueryClient } from '@/test/render';

const base = {
    automationId: 'a1', runs: [], selectedRunId: null, onOpenRun: vi.fn(),
};

describe('RunList — a list that could not be read', () => {
    it('says so and reads again on "Try again"', async () => {
        const user = userEvent.setup();
        const onReload = vi.fn();
        render(withQueryClient(<RunList {...base} loading={false} failed onReload={onReload} />));
        expect(screen.getByRole('alert')).toHaveTextContent('Could not read the runs.');
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('an empty list that did load says nothing matches, with no retry', () => {
        render(withQueryClient(<RunList {...base} loading={false} failed={false} onReload={vi.fn()} />));
        expect(screen.getByText('No runs match these filters.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });
});
