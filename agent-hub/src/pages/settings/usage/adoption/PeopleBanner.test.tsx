import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeopleBanner } from './PeopleBanner';

const view = (reveal: boolean) => ({ reveal, auditRecorded: reveal, people: [], total: 0 });
const base = { revealedAt: null, scopeLabel: 'range 30d · all groups', loading: false, auditFailed: false, onReveal: () => {}, onHide: () => {} };

describe('PeopleBanner', () => {
    it('offers the reveal while names are hidden', async () => {
        const user = userEvent.setup();
        const onReveal = vi.fn();
        render(<PeopleBanner {...base} view={view(false)} revealed={false} onReveal={onReveal} />);
        expect(screen.getByText('Names are hidden')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        expect(onReveal).toHaveBeenCalledTimes(1);
    });

    it('waits for the server before saying names are shown', () => {
        render(<PeopleBanner {...base} loading view={null} revealed />);
        expect(screen.getByRole('button', { name: 'Revealing…' })).toHaveProperty('disabled', true);
        expect(screen.queryByText(/Names shown/)).toBeNull();
    });

    it('names the audit entry and the filter once revealed, and hides on request', async () => {
        const user = userEvent.setup();
        const onHide = vi.fn();
        render(<PeopleBanner {...base} view={view(true)} revealed revealedAt={Date.parse('2026-11-05T14:02:00Z')} onHide={onHide} />);
        const status = screen.getByRole('status');
        expect(status.textContent).toContain('usage_adoption_people_revealed');
        expect(status.textContent).toContain('range 30d · all groups');
        await user.click(screen.getByRole('button', { name: 'Hide names' }));
        expect(onHide).toHaveBeenCalledTimes(1);
    });

    it('says the reveal was refused when the audit log could not record it', () => {
        render(<PeopleBanner {...base} auditFailed view={null} revealed />);
        expect(screen.getByText('Names not revealed')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Reveal names' })).toBeNull();
    });
});
