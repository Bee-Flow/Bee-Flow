import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import ComposerToolsMenu from './ComposerToolsMenu';

/**
 * The composer used to carry up to eight loose icons. They are rows behind one
 * "+" now, so the invariants worth pinning are: nothing became unreachable,
 * hovering a picker row reveals it beside the menu rather than replacing it,
 * state that used to be visible as a lit icon is still advertised while the
 * menu is shut, and the pickers that own their own panels still get a
 * positioning root even when they have no row.
 */

const openMenu = async (user) => {
    await user.click(screen.getByTestId('composer-tools-button'));
};

describe('ComposerToolsMenu', () => {
    it('shows one trigger, and the rows only once opened', async () => {
        const user = userEvent.setup();
        render(<ComposerToolsMenu items={[
            { id: 'attach', label: 'Add photos & files', group: 'add', kind: 'action', onSelect: vi.fn() },
            { id: 'web-search', label: 'Web search', group: 'mode', kind: 'toggle', onSelect: vi.fn() },
        ]} />);

        expect(screen.queryByTestId('composer-tools-panel')).not.toBeInTheDocument();
        await openMenu(user);
        expect(screen.getByTestId('composer-tool-attach')).toBeInTheDocument();
        expect(screen.getByTestId('composer-tool-web-search')).toBeInTheDocument();
    });

    it('skips falsy entries so callers can inline their gating', async () => {
        const user = userEvent.setup();
        render(<ComposerToolsMenu items={[
            { id: 'attach', label: 'Add photos & files', kind: 'action', onSelect: vi.fn() },
            false && { id: 'skills', label: 'Skills', kind: 'panel', onOpenChange: vi.fn() },
            null,
        ]} />);

        await openMenu(user);
        expect(screen.getByTestId('composer-tool-attach')).toBeInTheDocument();
        expect(screen.queryByTestId('composer-tool-skills')).not.toBeInTheDocument();
    });

    it('hovering a picker row opens it beside the menu, menu still up', async () => {
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        render(<ComposerToolsMenu items={[
            { id: 'apps', label: 'Apps', group: 'reach', kind: 'panel', open: false, onOpenChange },
        ]} />);

        await openMenu(user);
        await user.hover(screen.getByTestId('composer-tool-apps'));
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
        expect(screen.getByTestId('composer-tools-panel')).toBeInTheDocument();
    });

    it('hovering away from a picker puts it back', async () => {
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        render(<ComposerToolsMenu items={[
            { id: 'apps', label: 'Apps', group: 'reach', kind: 'panel', open: true, onOpenChange },
            { id: 'web-search', label: 'Web search', group: 'mode', kind: 'toggle', onSelect: vi.fn() },
        ]} />);

        await openMenu(user);
        await user.hover(screen.getByTestId('composer-tool-web-search'));
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it('only one picker is open at a time', async () => {
        const user = userEvent.setup();
        const appsOpenChange = vi.fn();
        const skillsOpenChange = vi.fn();
        render(<ComposerToolsMenu items={[
            { id: 'apps', label: 'Apps', group: 'reach', kind: 'panel', open: true, onOpenChange: appsOpenChange },
            { id: 'skills', label: 'Skills', group: 'reach', kind: 'panel', open: false, onOpenChange: skillsOpenChange },
        ]} />);

        await openMenu(user);
        await user.hover(screen.getByTestId('composer-tool-skills'));
        await waitFor(() => expect(skillsOpenChange).toHaveBeenCalledWith(true));
        expect(appsOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes behind an action, but not behind a toggle', async () => {
        const user = userEvent.setup();
        const onToggle = vi.fn();
        const onAction = vi.fn();
        render(<ComposerToolsMenu items={[
            { id: 'web-search', label: 'Web search', group: 'mode', kind: 'toggle', onSelect: onToggle },
            { id: 'attach', label: 'Add photos & files', group: 'add', kind: 'action', onSelect: onAction },
        ]} />);

        await openMenu(user);
        // Flipping two switches in a row must not mean reopening the menu twice.
        await user.click(screen.getByTestId('composer-tool-web-search'));
        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('composer-tools-panel')).toBeInTheDocument();

        await user.click(screen.getByTestId('composer-tool-attach'));
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('composer-tools-panel')).not.toBeInTheDocument();
    });

    it('a disabled row is inert', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        render(<ComposerToolsMenu items={[
            { id: 'web-search', label: 'Web search', kind: 'toggle', disabled: true, hint: 'Blocked by policy', onSelect },
        ]} />);

        await openMenu(user);
        await user.click(screen.getByTestId('composer-tool-web-search'));
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('advertises live state while shut — otherwise collapsing the row hides it', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<ComposerToolsMenu items={[
            { id: 'web-search', label: 'Web search', kind: 'toggle', on: false, dot: false, onSelect: vi.fn() },
        ]} />);
        expect(screen.queryByTestId('composer-tools-dot')).not.toBeInTheDocument();

        rerender(<ComposerToolsMenu items={[
            { id: 'web-search', label: 'Web search', kind: 'toggle', on: true, dot: true, onSelect: vi.fn() },
        ]} />);
        expect(screen.getByTestId('composer-tools-dot')).toBeInTheDocument();

        // …and gets out of the way once the panel says the same thing in words.
        await openMenu(user);
        expect(screen.queryByTestId('composer-tools-dot')).not.toBeInTheDocument();
        expect(screen.getByTestId('composer-tool-web-search')).toHaveAttribute('aria-checked', 'true');
    });

    it('renders the handed-off pickers even when no row survives its gating', () => {
        // A picker row and the picker it opens are gated separately; the picker
        // must never lose its positioning root along with the button.
        render(
            <ComposerToolsMenu items={[]}>
                <div data-testid="kb-panel" />
            </ComposerToolsMenu>,
        );
        expect(screen.queryByTestId('composer-tools-button')).not.toBeInTheDocument();
        expect(screen.getByTestId('kb-panel')).toBeInTheDocument();
    });

    it('closes on Escape, and takes its flyout with it', async () => {
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        render(<ComposerToolsMenu items={[
            { id: 'apps', label: 'Apps', kind: 'panel', open: true, onOpenChange },
        ]} />);

        await openMenu(user);
        await user.keyboard('{Escape}');
        expect(screen.queryByTestId('composer-tools-panel')).not.toBeInTheDocument();
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});
