import { fireEvent, render, screen } from '@testing-library/react';
import { Settings } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import StudioSectionHeader, { OBJHEAD, OBJHEAD_FOLD, PRIMARY_ACTION_STYLE } from './StudioSectionHeader';

/**
 * The one 48px header every Studio object opens with (artboard 1b). What is
 * pinned here is the CONTRACT its callers rely on:
 *   - the tile follows the kind (kindColors), never a colour of its own;
 *   - tabs are a radiogroup with the badge slot — a count renders after the
 *     label in its tone, no count renders NOTHING (never a "0");
 *   - the back arrow names WHERE it goes; the title renames inline and never
 *     calls back with an empty or unchanged name;
 *   - the narrow-width tab menu offers the same tabs with the same counts.
 */

const TABS = [
    { id: 'content', label: 'Content' },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'review', label: 'Review', count: 2, tone: 'error' },
    { id: 'usage', label: 'Used by', count: 3 },
];

function renderHeader(props = {}) {
    return render(
        <StudioSectionHeader
            kind="kb"
            title="Offerte-kennis"
            tabs={TABS}
            activeTab="content"
            onTab={() => {}}
            {...props}
        />,
    );
}

describe('StudioSectionHeader — tile, title, chip', () => {
    it('paints the 28px tile in the kind colour at 18%, shape per kind', () => {
        renderHeader();
        const tile = screen.getByTestId('studio-section-kind');
        expect(tile.dataset.kind).toBe('kb');
        expect(tile.style.width).toBe('28px');
        expect(tile.style.height).toBe('28px');
        expect(tile.style.background).toContain('var(--kind-kb) 18%');
        expect(tile.style.color).toBe('var(--kind-kb)');
        expect(tile.style.borderRadius).toBe('8px');
    });

    it('resolves aliases and keeps the trigger shape for an automation', () => {
        renderHeader({ kind: 'automation' });
        const tile = screen.getByTestId('studio-section-kind');
        expect(tile.dataset.kind).toBe('automation');
        expect(tile.style.borderRadius).toBe('14px 8px 8px 14px');
        expect(tile.style.color).toBe('var(--type-trigger)');
    });

    it('shows the name and falls back to Untitled', () => {
        const { unmount } = renderHeader();
        expect(screen.getByTestId('studio-section-title')).toHaveTextContent('Offerte-kennis');
        unmount();
        renderHeader({ title: '   ' });
        expect(screen.getByTestId('studio-section-title')).toHaveTextContent('Untitled');
    });

    it('paints a string statusChip as the 11px chip and a node as-is', () => {
        const { unmount } = renderHeader({ statusChip: 'Saved · v3' });
        const chip = screen.getByTestId('studio-section-status');
        expect(chip).toHaveTextContent('Saved · v3');
        expect(chip.style.borderRadius).toBe('999px');
        expect(chip.style.border).toContain('var(--border-default)');
        expect(chip.style.color).toBe('var(--text-tertiary)');
        unmount();
        renderHeader({ statusChip: <span data-testid="custom-chip">Saving…</span> });
        expect(screen.getByTestId('custom-chip')).toBeInTheDocument();
        expect(screen.queryByTestId('studio-section-status')).toBeNull();
    });

    it('renders no chip at all when there is none', () => {
        renderHeader();
        expect(screen.queryByTestId('studio-section-status')).toBeNull();
    });
});

describe('StudioSectionHeader — back and rename', () => {
    it('renders no back arrow without onBack, and a named one with it', () => {
        const { unmount } = renderHeader();
        expect(screen.queryByTestId('studio-section-back')).toBeNull();
        unmount();
        const onBack = vi.fn();
        renderHeader({ onBack, backLabel: 'Back to Knowledge' });
        const back = screen.getByRole('button', { name: 'Back to Knowledge' });
        fireEvent.click(back);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('falls back to a plain Back label', () => {
        renderHeader({ onBack: () => {} });
        expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    });

    it('is a heading, not a button, without onRename', () => {
        renderHeader();
        expect(screen.getByTestId('studio-section-title').tagName).toBe('H1');
    });

    it('renames inline: click → input, Enter commits the trimmed name', () => {
        const onRename = vi.fn();
        renderHeader({ onRename });
        fireEvent.click(screen.getByTestId('studio-section-title'));
        const input = screen.getByTestId('studio-section-title-input');
        expect(input.value).toBe('Offerte-kennis');
        fireEvent.change(input, { target: { value: '  Offertes  ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onRename).toHaveBeenCalledWith('Offertes');
        expect(screen.queryByTestId('studio-section-title-input')).toBeNull();
    });

    it('never calls back with an empty or unchanged name; Escape cancels', () => {
        const onRename = vi.fn();
        renderHeader({ onRename });
        fireEvent.click(screen.getByTestId('studio-section-title'));
        let input = screen.getByTestId('studio-section-title-input');
        fireEvent.change(input, { target: { value: '' } });
        fireEvent.blur(input);
        expect(onRename).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('studio-section-title'));
        input = screen.getByTestId('studio-section-title-input');
        fireEvent.blur(input);
        expect(onRename).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('studio-section-title'));
        input = screen.getByTestId('studio-section-title-input');
        fireEvent.change(input, { target: { value: 'Something else' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(onRename).not.toHaveBeenCalled();
        expect(screen.getByTestId('studio-section-title')).toHaveTextContent('Offerte-kennis');
    });
});

describe('StudioSectionHeader — tabs and badges', () => {
    it('renders the tabs as a radiogroup and reports the active one', () => {
        renderHeader({ activeTab: 'settings' });
        const group = screen.getByRole('radiogroup', { name: 'Sections' });
        const radios = group.querySelectorAll('[role="radio"]');
        expect(radios).toHaveLength(4);
        expect(screen.getByRole('radio', { name: /Settings/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: /Content/ })).toHaveAttribute('aria-checked', 'false');
    });

    it('calls onTab with the id', () => {
        const onTab = vi.fn();
        renderHeader({ onTab });
        fireEvent.click(screen.getByRole('radio', { name: /Used by/ }));
        expect(onTab).toHaveBeenCalledWith('usage');
    });

    it('shows a count after the label in its tone, and nothing without one', () => {
        renderHeader();
        const usage = screen.getByRole('radio', { name: /Used by/ });
        expect(usage.textContent).toBe('Used by3');
        const usageBadge = usage.querySelector('[data-tone]');
        expect(usageBadge.dataset.tone).toBe('neutral');
        expect(usageBadge.style.color).toBe('var(--text-tertiary)');

        const review = screen.getByRole('radio', { name: /Review/ });
        expect(review.textContent).toBe('Review2');
        expect(review.querySelector('[data-tone]').style.color).toBe('var(--error)');

        const content = screen.getByRole('radio', { name: /Content/ });
        expect(content.textContent).toBe('Content');
        expect(content.querySelector('[data-tone]')).toBeNull();
    });

    it('folds a tab label behind its icon at the first stage', () => {
        renderHeader();
        const settings = screen.getByRole('radio', { name: /Settings/ });
        const label = settings.querySelector(`.${CSS.escape(OBJHEAD_FOLD.label)}`);
        expect(label).not.toBeNull();
        expect(label).toHaveTextContent('Settings');
        expect(settings.querySelector('svg')).not.toBeNull();
        // A tab without an icon keeps its label unconditionally.
        const content = screen.getByRole('radio', { name: /Content/ });
        expect(content.querySelector(`.${CSS.escape(OBJHEAD_FOLD.label)}`)).toBeNull();
    });

    it('folds the strip into the menu at 900px with tabsFold="compact", at 1180px without it', () => {
        const { unmount } = renderHeader();
        const stripOf = () => screen.getByRole('radiogroup').closest('div.flex-shrink-0');
        const menuOf = () => screen.getByTestId('studio-section-tab-menu').parentElement.parentElement;
        expect(stripOf().className).toContain('@max-[1180px]/objhead:hidden');
        expect(menuOf().className).toBe('hidden @max-[1180px]/objhead:block');
        unmount();
        renderHeader({ tabsFold: 'compact' });
        expect(stripOf().className).toContain('@max-[900px]/objhead:hidden');
        expect(menuOf().className).toBe('hidden @max-[900px]/objhead:block');
    });

    it('titleMin keeps the name wrapper from shrinking', () => {
        const { unmount } = renderHeader();
        expect(screen.getByTestId('studio-section-title').parentElement.className).toMatch(/^min-w-0 /);
        unmount();
        renderHeader({ titleMin: true });
        expect(screen.getByTestId('studio-section-title').parentElement.className).toMatch(/^shrink-0 max-w-/);
    });

    it('renders no strip and no menu without tabs', () => {
        renderHeader({ tabs: null });
        expect(screen.queryByRole('radiogroup')).toBeNull();
        expect(screen.queryByTestId('studio-section-tab-menu')).toBeNull();
    });

    it('offers the same tabs with the same counts in the narrow-width menu', () => {
        const onTab = vi.fn();
        renderHeader({ onTab, activeTab: 'review' });
        const trigger = screen.getByTestId('studio-section-tab-menu');
        expect(trigger).toHaveTextContent('Review2');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        const items = screen.getAllByRole('menuitemradio');
        expect(items.map((el) => el.textContent)).toEqual(['Content', 'Settings', 'Review2', 'Used by3']);
        expect(screen.getByRole('menuitemradio', { name: /Review/ })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByRole('menuitemradio', { name: /Used by/ }));
        expect(onTab).toHaveBeenCalledWith('usage');
        expect(screen.queryByRole('menu')).toBeNull();
    });
});

describe('StudioSectionHeader — slots and exports', () => {
    it('places capsule, primary and extras in that order in the action cluster', () => {
        renderHeader({
            capsule: <span data-testid="s-capsule">Organisation</span>,
            primary: <button type="button" data-testid="s-primary" style={PRIMARY_ACTION_STYLE}>Publish</button>,
            extras: <span data-testid="s-extras">…</span>,
        });
        const cluster = screen.getByTestId('studio-section-actions');
        const ids = Array.from(cluster.children).map((el) => el.dataset.testid);
        expect(ids).toEqual(['s-capsule', 's-primary', 's-extras']);
        const primary = screen.getByTestId('s-primary');
        expect(primary.style.background).toBe('var(--accent-primary)');
        expect(primary.style.color).toBe('var(--accent-primary-fg)');
    });

    it('renders no action cluster when every slot is empty', () => {
        renderHeader();
        expect(screen.queryByTestId('studio-section-actions')).toBeNull();
    });

    it('exports the container name the status pill folds against', () => {
        expect(OBJHEAD).toBe('objhead');
        expect(OBJHEAD_FOLD.label).toContain('/objhead:');
        expect(OBJHEAD_FOLD.action).toContain('/objhead:');
        expect(OBJHEAD_FOLD.compact).toBe('@max-[900px]/objhead:hidden');
    });
});
