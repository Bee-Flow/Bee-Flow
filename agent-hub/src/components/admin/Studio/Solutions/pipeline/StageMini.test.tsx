import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StageMini from './StageMini';

describe('StageMini', () => {
    it('lists the three stages with their release', () => {
        render(<StageMini current="uat" stages={[
            { name: 'dev', release: 'v3' },
            { name: 'uat', release: 'v2', state: 'waiting' },
            { name: 'prd', release: 'v1' },
        ]} />);
        const mini = screen.getByTestId('stage-mini');
        expect(within(mini).getAllByRole('listitem')).toHaveLength(3);
        expect(within(mini).getByText('v2')).toBeInTheDocument();
        expect(screen.getByTestId('stage-mini-uat')).toHaveAttribute('aria-current', 'step');
        expect(screen.getByTestId('stage-mini-uat')).toHaveAttribute('data-state', 'waiting');
        expect(screen.getByTestId('stage-mini-dev')).not.toHaveAttribute('aria-current');
    });

    it('defaults a stage without state to ok', () => {
        render(<StageMini stages={[{ name: 'prd' }]} />);
        expect(screen.getByTestId('stage-mini-prd')).toHaveAttribute('data-state', 'ok');
    });
});
