import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Toggle from './Toggle';

describe('Toggle', () => {
    it('renders a label + description in row mode and reflects checked state', () => {
        render(<Toggle checked label="Web Embed" description="Public chat" onChange={() => {}} />);
        expect(screen.getByText('Web Embed')).toBeInTheDocument();
        expect(screen.getByText('Public chat')).toBeInTheDocument();
        expect(screen.getByRole('switch')).toBeChecked();
    });

    it('calls onChange with the next boolean when the user clicks', async () => {
        const onChange = vi.fn();
        render(<Toggle checked={false} label="Allow Copying" onChange={onChange} />);
        await userEvent.click(screen.getByRole('switch'));
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it('renders the bare switch (no row chrome) when no label or description is given', () => {
        render(<Toggle checked={false} onChange={() => {}} ariaLabel="enabled" />);
        // No <h4>, no <p> — just the input.
        expect(screen.queryByRole('heading')).toBeNull();
        const cb = screen.getByRole('switch', { name: 'enabled' });
        expect(cb).not.toBeChecked();
        expect(cb).toHaveAttribute('aria-checked', 'false');
    });

    it('does not fire onChange when disabled', async () => {
        const onChange = vi.fn();
        render(<Toggle checked={false} label="Locked" disabled onChange={onChange} />);
        await userEvent.click(screen.getByRole('switch'));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('falls back to label text for aria-label when the caller did not pass ariaLabel', () => {
        render(<Toggle checked={false} label="My Setting" onChange={() => {}} />);
        // RTL's accessible-name resolution walks the linked label too, so getByRole
        // with name should find the checkbox regardless of where the name comes from.
        expect(screen.getByRole('switch', { name: /my setting/i })).toBeInTheDocument();
    });

    it('draws ON in ink and OFF on the off track, from theme tokens only', () => {
        const { container } = render(<Toggle checked onChange={() => {}} ariaLabel="on" />);
        expect(screen.getByRole('switch', { name: 'on' })).toHaveAttribute('aria-checked', 'true');
        const track = container.querySelector('span[aria-hidden="true"]');
        expect(track?.className).toContain('peer-checked:bg-[var(--text-primary)]');
        expect(track?.className).toContain('bg-[var(--control-track-off)]');
        expect(track?.className).toContain('after:bg-[var(--control-knob)]');
        expect(track?.className).toContain('after:border-[var(--border-default)]');
        expect(track?.className).not.toMatch(/emerald|amber|rose|sky|gray-|bg-white/);
    });

    it('sits on the settings surface in row mode, and on none in flat mode', () => {
        const { container, rerender } = render(<Toggle checked={false} label="Row" description="Hint" onChange={() => {}} />);
        const row = container.querySelector('label');
        expect(row?.className).toContain('bg-[var(--bg-primary)]');
        expect(row?.className).toContain('border-[var(--border-default)]');
        expect(screen.getByText('Hint').className).toContain('text-[var(--text-secondary)]');
        rerender(<Toggle checked={false} label="Row" description="Hint" onChange={() => {}} flat />);
        const flat = container.querySelector('label');
        expect(flat?.className).not.toContain('bg-[var(--bg-primary)]');
        expect(flat?.className).not.toContain('border');
    });
});
