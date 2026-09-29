import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ActionChoiceCards from './ActionChoiceCards';
import { PRIMARY_KINDS } from './actionKindCatalog';

/**
 * The four cards, and — more importantly — what happens when the action is
 * none of the four.
 *
 * A card group with nothing checked is ambiguous: it could mean "no choice made
 * yet" or "the choice is not on this list". The second is the common case (a
 * send_email action, a flow the AI wrote), and reading it as the first is how
 * an author ends up clicking a card and replacing an action they only wanted to
 * look at.
 */

function renderCards(kind, props = {}) {
    const onPickKind = vi.fn();
    render(<ActionChoiceCards kind={kind} onPickKind={onPickKind} {...props} />);
    return { onPickKind };
}

const allOptionsToggle = () => screen.getByRole('button', { name: /all options/i });

describe('ActionChoiceCards — the four', () => {
    it('offers exactly the four primary kinds as radio cards', () => {
        renderCards('toast');
        const radios = screen.getAllByRole('radio');
        expect(radios).toHaveLength(PRIMARY_KINDS.length);
        // Radio semantics, not coloured buttons: the state a sighted user reads
        // from the border has to be readable by everyone.
        expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    });

    it('each card explains its consequence, not just its name', () => {
        renderCards('toast');
        expect(screen.getByText(/one of your routines/i)).toBeInTheDocument();
        expect(screen.getByText(/new row into one of this app/i)).toBeInTheDocument();
    });

    it('picking a card reports the kind', () => {
        const { onPickKind } = renderCards('toast');
        fireEvent.click(screen.getByRole('radio', { name: /Add a row/ }));
        expect(onPickKind).toHaveBeenCalledWith('create_record');
    });

    it('keeps "All options" closed when the action IS one of the four', () => {
        renderCards('run_automation');
        expect(allOptionsToggle()).toHaveAttribute('aria-expanded', 'false');
    });

    it('disables every card while the AI builder streams', () => {
        renderCards('toast', { disabled: true });
        for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    });
});

describe('ActionChoiceCards — when the action is none of the four', () => {
    it('checks no card, says what the action actually is, and opens All options', () => {
        renderCards('send_email');
        expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(0);
        expect(screen.getByText(/something else: Send an e-mail/i)).toBeInTheDocument();
        expect(allOptionsToggle()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('combobox', { name: 'Action kind' })).toHaveValue('send_email');
    });

    /**
     * A kind from a NEWER build than this one. The select used to silently
     * display "Run routine" for it, and the first change replaced the whole
     * action — which is the destructive version of lying about what something
     * is.
     */
    it('names an unknown kind instead of claiming it is a routine', () => {
        renderCards('teleport_user');
        expect(screen.getByText(/does not know/i)).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Action kind' })).toHaveValue('teleport_user');
    });
});

describe('ActionChoiceCards — All options', () => {
    it('carries the extra affordances handed to it', () => {
        render(
            <ActionChoiceCards kind="toast" onPickKind={vi.fn()}>
                <button type="button">Edit the flow</button>
            </ActionChoiceCards>,
        );
        // Hidden until opened, then reachable — never unreachable.
        expect(screen.queryByRole('button', { name: 'Edit the flow' })).toBeNull();
        fireEvent.click(allOptionsToggle());
        expect(screen.getByRole('button', { name: 'Edit the flow' })).toBeInTheDocument();
    });

    it('offers every kind the catalog knows, each under a real name', () => {
        renderCards('send_email');
        const options = Array.from(screen.getByRole('combobox', { name: 'Action kind' }).options);
        expect(options.length).toBeGreaterThanOrEqual(12);
        for (const option of options) {
            expect(option.textContent.trim().length).toBeGreaterThan(0);
            expect(option.textContent.trim()).not.toBe(option.value);
        }
    });
});
