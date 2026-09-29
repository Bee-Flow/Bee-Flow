import { render, screen, fireEvent } from '@testing-library/react';
import { Power, Upload } from 'lucide-react';
import { describe, it, expect, vi } from 'vitest';
import StatusActionPill, { FOLD_CLASSES } from './StatusActionPill';
import { STATUSES } from './statusOf';

/**
 * The split pill every Studio header paints its state with. Two decisions
 * are pinned here because they were made against the artboard:
 *   - the primary action wears the theme's accent + --accent-primary-fg,
 *     never the artboard's ink fill (user feedback 2026-09-03);
 *   - `stale` exists, wears --warning and offers Republish — the artboard's
 *     two-state capsule would have hidden a published-but-behind app.
 */

const pill = () => screen.getByTestId('status-pill');
const statusCell = () => pill().firstElementChild;
const dot = () => statusCell().firstElementChild;

describe('StatusActionPill — status half', () => {
    it('paints live and published in the success tint, dot included', () => {
        for (const status of ['live', 'published']) {
            const { unmount } = render(<StatusActionPill status={status} />);
            expect(pill().dataset.status).toBe(status);
            expect(pill().dataset.tone).toBe('success');
            expect(statusCell().style.color).toContain('var(--success)');
            expect(dot().style.background).toContain('var(--success)');
            unmount();
        }
    });

    it('paints stale — published but behind — in the warning tint', () => {
        render(<StatusActionPill status="stale" />);
        expect(pill().dataset.tone).toBe('warning');
        expect(statusCell().style.color).toContain('var(--warning)');
        expect(dot().style.background).toContain('var(--warning)');
        expect(screen.getByText('Outdated')).toBeInTheDocument();
    });

    it('keeps draft, paused and unknown neutral', () => {
        for (const status of ['draft', 'paused', 'unknown']) {
            const { unmount } = render(<StatusActionPill status={status} />);
            expect(pill().dataset.tone).toBe('neutral');
            expect(statusCell().style.color).toContain('var(--text-secondary)');
            expect(statusCell().style.background).toBe('');
            unmount();
        }
    });

    it('gives unknown a hollow dot — nothing is claimed', () => {
        render(<StatusActionPill status="unknown" />);
        expect(dot().style.background).toBe('transparent');
        expect(dot().style.boxShadow).toContain('var(--text-tertiary)');
    });

    it('names every status in plain English, never a raw key', () => {
        const words = {};
        for (const status of STATUSES) {
            const { unmount } = render(<StatusActionPill status={status} />);
            words[status] = statusCell().textContent.trim();
            expect(words[status]).not.toMatch(/^studio\./);
            expect(words[status].length).toBeGreaterThan(0);
            unmount();
        }
        expect(words.live).toBe('Live');
        expect(words.paused).toBe('Paused');
        expect(words.draft).toBe('Draft');
        expect(words.published).toBe('Published');
    });

    it('treats a word outside the vocabulary as unknown instead of crashing', () => {
        render(<StatusActionPill status="banana" />);
        expect(pill().dataset.status).toBe('unknown');
        expect(screen.getByText('Unknown')).toBeInTheDocument();
    });

    it('lets a caller keep its own richer label', () => {
        render(<StatusActionPill status="live" label="Live · 3 groups" />);
        expect(screen.getByText('Live · 3 groups')).toBeInTheDocument();
        expect(screen.queryByText('Live')).toBeNull();
        expect(pill().dataset.tone).toBe('success');
    });

    it('is the status half alone when there is no action', () => {
        render(<StatusActionPill status="draft" />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(pill().children).toHaveLength(1);
    });
});

describe('StatusActionPill — action half', () => {
    it('paints the forward action in the theme\'s primary recipe: accent with its paired foreground', () => {
        // The accent defaults to #9ca3af; white-on-accent measured ~2.5:1, so
        // the fill must come with --accent-primary-fg. The ink-filled pill of
        // artboard 1b read as a black block against a light chrome.
        render(<StatusActionPill status="draft" action={{ label: 'Activate', icon: Power, onClick: vi.fn() }} />);
        const btn = screen.getByRole('button', { name: 'Activate' });
        expect(btn.style.background).toContain('var(--accent-primary)');
        expect(btn.style.color).toContain('var(--accent-primary-fg)');
        expect(btn.className).not.toContain('text-white');
        expect(btn.querySelector('svg')).not.toBeNull();
    });

    it('keeps the quieting action on a live thing plain', () => {
        render(<StatusActionPill status="live" action={{ label: 'Pause', icon: Power, onClick: vi.fn() }} />);
        const btn = screen.getByRole('button', { name: 'Pause' });
        expect(btn.style.background).toBe('');
        expect(btn.className).toContain('hover:bg-[var(--bg-tertiary)]');
    });

    it('lets action.primary override the guess in both directions', () => {
        const { unmount } = render(<StatusActionPill status="live" action={{ label: 'Go', primary: true }} />);
        expect(screen.getByRole('button', { name: 'Go' }).style.background).toContain('var(--accent-primary)');
        unmount();
        render(<StatusActionPill status="draft" action={{ label: 'Discard', primary: false }} />);
        expect(screen.getByRole('button', { name: 'Discard' }).style.background).toBe('');
    });

    it('defaults the stale action to Republish, as a primary', () => {
        const onClick = vi.fn();
        render(<StatusActionPill status="stale" action={{ icon: Upload, onClick }} />);
        const btn = screen.getByRole('button', { name: 'Republish' });
        expect(btn).toHaveTextContent('Republish');
        expect(btn.style.background).toContain('var(--accent-primary)');
        fireEvent.click(btn);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('wires onClick, disabled, title and an explicit aria-label', () => {
        const onClick = vi.fn();
        const { rerender } = render(
            <StatusActionPill
                status="paused"
                action={{ label: 'Activate', onClick, title: 'Add a trigger first', ariaLabel: 'Activate automation', disabled: true }}
            />,
        );
        const btn = screen.getByRole('button', { name: 'Activate automation' });
        expect(btn).toBeDisabled();
        expect(btn.title).toBe('Add a trigger first');
        fireEvent.click(btn);
        expect(onClick).not.toHaveBeenCalled();
        rerender(<StatusActionPill status="paused" action={{ label: 'Activate', onClick }} />);
        fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('accepts a ready icon element as well as a lucide component', () => {
        render(<StatusActionPill status="draft" action={{ label: 'Publish', icon: <Upload data-testid="ic" /> }} />);
        expect(screen.getByTestId('ic')).toBeInTheDocument();
    });
});

describe('StatusActionPill — folding and identity', () => {
    it('folds against the host bar by default: status word < 1440px, action word < 1180px', () => {
        render(<StatusActionPill status="live" action={{ label: 'Pause' }} />);
        expect(screen.getByText('Live').className).toBe(FOLD_CLASSES.bar.status);
        expect(screen.getByText('Pause').className).toBe(FOLD_CLASSES.bar.action);
        expect(FOLD_CLASSES.bar.status).toBe('@max-[1440px]/bar:hidden');
        expect(FOLD_CLASSES.bar.action).toBe('@max-[1180px]/bar:hidden');
    });

    it('addresses whichever container it is told about', () => {
        render(<StatusActionPill status="live" action={{ label: 'Pause' }} containerName="edhead" />);
        expect(screen.getByText('Live').className).toBe('@max-[1440px]/edhead:hidden');
        expect(screen.getByText('Pause').className).toBe('@max-[1180px]/edhead:hidden');
    });

    it('never folds when there is no container', () => {
        render(<StatusActionPill status="live" action={{ label: 'Pause' }} containerName={null} />);
        expect(screen.getByText('Live').className).toBe('');
        expect(screen.getByText('Pause').className).toBe('');
    });

    it('keeps the status-pill test id and lets a page rename it', () => {
        const { unmount } = render(<StatusActionPill status="draft" />);
        expect(screen.getByTestId('status-pill')).toBeInTheDocument();
        unmount();
        render(<StatusActionPill status="draft" testId="agent-status" />);
        expect(screen.getByTestId('agent-status')).toBeInTheDocument();
        expect(screen.queryByTestId('status-pill')).toBeNull();
    });

    it('keeps the artboard\'s shape: 32px, radius 10, one bordered strip', () => {
        render(<StatusActionPill status="live" action={{ label: 'Pause' }} />);
        const cls = pill().className;
        expect(cls).toContain('h-8');
        expect(cls).toContain('rounded-[10px]');
        expect(cls).toContain('border-[var(--border-default)]');
        // …and never the rejected ink fill.
        expect(pill().style.background).toBe('');
        expect(cls).not.toContain('bg-[var(--text-primary)]');
    });
});
