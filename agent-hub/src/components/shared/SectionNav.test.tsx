import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Shield, Users } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import SectionNav from './SectionNav';

const items = [
    { id: 'users', label: 'Users', icon: Users, group: 'People' },
    { id: 'roles', label: 'Roles', group: 'People', testId: 'nav-roles' },
    { id: 'guardrails', label: 'Guardrails', icon: Shield, group: 'Safety', title: 'PII and topic guardrails' },
];

describe('SectionNav', () => {
    it('is a named navigation with one button per section and the current one marked', () => {
        render(<SectionNav label="Security" items={items} activeId="roles" onSelect={() => {}} />);
        const nav = screen.getByRole('navigation', { name: 'Security' });
        expect(nav).toBeInTheDocument();
        expect(screen.getAllByRole('button')).toHaveLength(3);
        expect(screen.getByRole('button', { name: 'Roles' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Users' })).not.toHaveAttribute('aria-current');
        expect(screen.getByTestId('nav-roles')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Guardrails' })).toHaveAttribute('title', 'PII and topic guardrails');
    });

    it('prints a group eyebrow once, above the first row of the group', () => {
        render(<SectionNav label="Security" items={items} activeId="users" onSelect={() => {}} />);
        expect(screen.getAllByText('People')).toHaveLength(1);
        expect(screen.getAllByText('Safety')).toHaveLength(1);
    });

    it('hands the id of a clicked row to onSelect', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        render(<SectionNav label="Security" items={items} activeId="users" onSelect={onSelect} />);
        await user.click(screen.getByRole('button', { name: 'Guardrails' }));
        expect(onSelect).toHaveBeenCalledWith('guardrails');
    });
});
