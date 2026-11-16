import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Shield } from 'lucide-react';
import SectionHeader from './SectionHeader';

describe('SectionHeader', () => {
    it('renders the title, description and status slot', () => {
        render(<SectionHeader title="Encryption" description="How data is kept" status={<span>Saved</span>} />);
        expect(screen.getByRole('heading', { level: 2, name: 'Encryption' })).toBeInTheDocument();
        expect(screen.getByText('How data is kept').className).toContain('text-[var(--text-secondary)]');
        expect(screen.getByText('Saved')).toBeInTheDocument();
    });

    it('draws no icon unless one is given', () => {
        const { container } = render(<SectionHeader title="Plain" />);
        expect(container.querySelector('svg')).toBeNull();
    });

    it('takes an icon as a component (a rail row icon) or as an element, decoratively', () => {
        const { container, rerender } = render(<SectionHeader title="Security" icon={Shield} />);
        expect(container.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
        rerender(<SectionHeader title="Security" icon={<Shield data-testid="el" />} />);
        expect(screen.getByTestId('el')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
    });
});
