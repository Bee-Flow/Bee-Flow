import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import DashCard from './DashCard';
import DashSkeleton from './DashSkeleton';
import StatGrid from './StatGrid';
import StatTile from './StatTile';

describe('dashboard kit', () => {
    it('a StatTile is labelled with its name and value', () => {
        render(<StatGrid><StatTile label="Responses in this period" value={86} hint="of 128" /><StatTile label="Today" value={null} /></StatGrid>);
        expect(screen.getByLabelText('Responses in this period: 86')).toBeTruthy();
        expect(screen.getByLabelText('Today: —')).toBeTruthy();
        expect(screen.getByText('of 128')).toBeTruthy();
    });
    it('a DashCard is a labelled section with an action slot', () => {
        render(<DashCard title="Recent responses" meta="last 10" action={<button type="button">Export</button>}>body</DashCard>);
        const section = screen.getByRole('region', { name: 'Recent responses' });
        expect(section.textContent).toContain('body');
        expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
        expect(screen.getByText('last 10')).toBeTruthy();
    });
    it('a DashSkeleton announces itself as busy', () => {
        render(<DashSkeleton tiles={2} cards={1} />);
        expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    });
});
