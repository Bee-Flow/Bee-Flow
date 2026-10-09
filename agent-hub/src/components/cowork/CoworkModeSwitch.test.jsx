import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import CoworkModeSwitch from './CoworkModeSwitch';
import CoworkModeToggle from './CoworkModeToggle';

/**
 * CHARACTERISATION — the Chat ⇄ Cowork switch and the rule that decides
 * whether it is shown at all, exactly as they behave today.
 *
 * CoworkModeToggle is pinned here on purpose (it has no test file of its own):
 * PLAN-APP C14 keeps it deliberately, against the artboard, so a later cleanup
 * that quietly deletes it has to walk past a red test first.
 *
 * Nothing in this file is a recommendation. Tests named "wrat" pin something
 * that is plainly wrong and must fail loudly the day it is fixed.
 */

/**
 * The component's own source. The i18n wart below cannot be seen from the
 * rendered DOM — `t('key', 'Chat')` renders "Chat" as well — so the pin has to
 * read the module that produced it.
 */
const SWITCH_SOURCE = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'CoworkModeSwitch.jsx'),
    'utf8',
);

function renderSwitch(over = {}) {
    const props = { value: 'chat', onChange: vi.fn(), ...over };
    const utils = render(<CoworkModeSwitch {...props} />);
    return { ...utils, props };
}

const chatTab = () => screen.getByTestId('cowork-mode-chat');
const coworkTab = () => screen.getByTestId('cowork-mode-cowork');

describe('CoworkModeSwitch — what it renders', () => {
    it('is a tablist with exactly the two modes, Chat first', () => {
        renderSwitch();
        const list = screen.getByTestId('cowork-mode-switch');
        expect(list).toHaveAttribute('role', 'tablist');
        expect(list).toHaveAttribute('aria-label', 'Chat or Cowork');

        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(2);
        expect(tabs[0]).toHaveTextContent('Chat');
        expect(tabs[1]).toHaveTextContent('Cowork');
    });

    it('keeps the mode id and the caption the same word — "cowork", never "work"', () => {
        // They diverged once (id "work", caption "Cowork"), which is how one
        // feature ends up with two vocabularies. The testid carries the id.
        renderSwitch();
        expect(coworkTab()).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-mode-work')).not.toBeInTheDocument();
    });

    it('explains each mode in its title attribute', () => {
        renderSwitch();
        expect(chatTab()).toHaveAttribute('title', 'Answers you here, in the conversation');
        expect(coworkTab()).toHaveAttribute('title', 'Runs on its own — now or on a schedule');
    });

    it('the labels are the mode names in every language; the hints and the list label go through t()', () => {
        // Fixed 2026-10 (it was pinned here as a wart): the hints and the
        // tablist label have keys, so a Dutch UI no longer shows an English
        // hint next to translated chrome. "Chat" and "Cowork" are names.
        renderSwitch();
        expect(chatTab().textContent).toBe('Chat');
        expect(coworkTab().textContent).toBe('Cowork');
        expect(coworkTab().getAttribute('title')).toBe('Runs on its own — now or on a schedule');
        // The strings alone do not pin this — t('k', 'Chat') renders "Chat"
        // too — so the module is read: every hint and the label carry a key.
        expect(SWITCH_SOURCE).toMatch(/useTranslation/);
        expect(SWITCH_SOURCE).toMatch(/hintKey: 'cowork\.mode_hint_chat'/);
        expect(SWITCH_SOURCE).toMatch(/hintKey: 'cowork\.mode_hint_cowork'/);
        expect(SWITCH_SOURCE).toMatch(/t\('cowork\.mode_switch_label'/);
    });

    it('appends the caller\'s className to the wrapper', () => {
        renderSwitch({ className: 'ml-auto shrink-0' });
        const list = screen.getByTestId('cowork-mode-switch');
        expect(list.className).toContain('ml-auto');
        expect(list.className).toContain('shrink-0');
    });
});

describe('CoworkModeSwitch — which tab reads as selected', () => {
    it('defaults to Chat when no value is given', () => {
        render(<CoworkModeSwitch onChange={vi.fn()} />);
        expect(chatTab()).toHaveAttribute('aria-selected', 'true');
        expect(coworkTab()).toHaveAttribute('aria-selected', 'false');
    });

    it('marks Cowork selected for value="cowork"', () => {
        renderSwitch({ value: 'cowork' });
        expect(coworkTab()).toHaveAttribute('aria-selected', 'true');
        expect(chatTab()).toHaveAttribute('aria-selected', 'false');
    });

    it('gives the selected tab a raised ground and the other one a transparent one', () => {
        renderSwitch({ value: 'cowork' });
        expect(coworkTab().style.background).toBe('var(--bg-primary)');
        expect(coworkTab().style.color).toBe('var(--text-primary)');
        expect(chatTab().style.background).toBe('transparent');
        expect(chatTab().style.color).toBe('var(--text-tertiary)');
    });

    it('wrat: an unknown value leaves BOTH tabs unselected instead of falling back to Chat', () => {
        // "work" is the legacy id this control used to ship with. Nothing
        // normalises it, so a stale caller renders a switch that claims no
        // mode is active while the composer is in one.
        renderSwitch({ value: 'work' });
        expect(chatTab()).toHaveAttribute('aria-selected', 'false');
        expect(coworkTab()).toHaveAttribute('aria-selected', 'false');
        expect(chatTab().style.background).toBe('transparent');
        expect(coworkTab().style.background).toBe('transparent');
    });
});

describe('CoworkModeSwitch — clicking', () => {
    it('reports the id of the tab you clicked', () => {
        const { props } = renderSwitch();
        fireEvent.click(coworkTab());
        expect(props.onChange).toHaveBeenCalledWith('cowork');
    });

    it('wrat: clicking the tab that is already active fires onChange again', () => {
        // No same-value guard. Every caller that resets composer state on a
        // mode change therefore resets it on a no-op click too.
        const { props } = renderSwitch({ value: 'chat' });
        fireEvent.click(chatTab());
        expect(props.onChange).toHaveBeenCalledTimes(1);
        expect(props.onChange).toHaveBeenCalledWith('chat');
    });

    it('survives being rendered without an onChange — the click is guarded, not thrown', () => {
        // `not.toThrow()` alone would pass without the guard: React catches a
        // handler that throws and re-reports it to window.onerror, so the
        // uncaught-error listener is the half that actually pins the guard.
        const uncaught = vi.fn();
        window.addEventListener('error', uncaught);
        try {
            render(<CoworkModeSwitch value="chat" />);
            expect(() => fireEvent.click(coworkTab())).not.toThrow();
        } finally {
            window.removeEventListener('error', uncaught);
        }
        expect(uncaught).not.toHaveBeenCalled();
    });
});

describe('CoworkModeSwitch — sizes', () => {
    it('uses the roomy padding by default', () => {
        renderSwitch();
        expect(chatTab().className).toContain('px-3.5');
        expect(chatTab().className).toContain('py-1.5');
        expect(chatTab().className).toContain('text-[12.5px]');
    });

    it('uses the compact padding for size="sm"', () => {
        renderSwitch({ size: 'sm' });
        expect(chatTab().className).toContain('px-2.5');
        expect(chatTab().className).toContain('py-1');
        expect(chatTab().className).toContain('text-[11.5px]');
    });

    it('wrat: any size other than "sm" is treated as the roomy one, silently', () => {
        // `compact = size === 'sm'` — a caller asking for 'lg' gets 'md'
        // without a warning.
        renderSwitch({ size: 'lg' });
        expect(chatTab().className).toContain('px-3.5');
    });
});

describe('CoworkModeToggle — whether the switch is shown at all', () => {
    it('renders nothing when the surface has not enabled Cowork', () => {
        const { container } = render(<CoworkModeToggle enabled={false} value="chat" onChange={vi.fn()} />);
        expect(container.firstChild).toBeNull();
        expect(screen.queryByTestId('cowork-mode-switch')).not.toBeInTheDocument();
    });

    it('renders nothing by default — `enabled` has to be asked for', () => {
        const { container } = render(<CoworkModeToggle onChange={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('disappears once the thread is locked, even while enabled', () => {
        // A thread with a message in it settles the mode: chat and cowork
        // produce different things and there is no halfway conversion.
        const { container } = render(
            <CoworkModeToggle enabled locked value="cowork" onChange={vi.fn()} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('C14: still exists — enabled and unlocked, it renders the real switch', () => {
        // Deliberate deviation from the artboard. If this test starts failing
        // because the component was "cleaned up", that was not agreed.
        render(<CoworkModeToggle enabled value="cowork" onChange={vi.fn()} />);
        expect(screen.getByTestId('cowork-mode-switch')).toBeInTheDocument();
        expect(coworkTab()).toHaveAttribute('aria-selected', 'true');
    });

    it('always hands the switch the compact size, whatever the caller wants', () => {
        render(<CoworkModeToggle enabled value="chat" onChange={vi.fn()} />);
        expect(chatTab().className).toContain('px-2.5');
        expect(chatTab().className).toContain('text-[11.5px]');
    });

    it('passes the click straight through to the caller', () => {
        const onChange = vi.fn();
        render(<CoworkModeToggle enabled value="chat" onChange={onChange} />);
        fireEvent.click(coworkTab());
        expect(onChange).toHaveBeenCalledWith('cowork');
    });

    it('wrat: `locked` wins over `value`, so a locked cowork thread shows no mode anywhere', () => {
        // The toggle is the only thing that states the mode. Locked, the
        // screen stops saying whether the composer answers you or goes away
        // and does the work.
        const { container } = render(
            <CoworkModeToggle enabled locked value="cowork" onChange={vi.fn()} />,
        );
        expect(container.textContent).toBe('');
    });
});
