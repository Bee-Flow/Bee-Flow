import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import CoworkOptionsBar from './CoworkOptionsBar';
import { COWORK_REPEAT_OPTIONS, WHEN_PRESETS } from './coworkSchedule';

/**
 * CHARACTERISATION — the three chips above the brief, exactly as they behave
 * today. Nothing here is a recommendation; several of these tests are named
 * "wrat" because they pin something that is plainly wrong and must keep
 * failing loudly once it is changed.
 *
 * The clock is frozen: the When chip prints a RESOLVED moment ("Today at
 * 13:00"), not the preset's own name, so without a fixed now the label is a
 * moving target.
 */

// Local-time construction — the assertions hold in whatever TZ the runner has.
const NOW = new Date(2026, 8, 6, 12, 0, 0);           // Sunday 6 Sep 2026, 12:00
const CLOCK = { hour: '2-digit', minute: '2-digit' };
const clockOf = (d) => d.toLocaleTimeString(undefined, CLOCK);

const noop = () => {};

function setup(over = {}) {
    const props = {
        when: { presetId: 'now', date: '', time: '' },
        onWhenChange: vi.fn(),
        repeatInterval: '',
        onRepeatChange: vi.fn(),
        agentId: '',
        onAgentChange: vi.fn(),
        agents: [],
        isMobile: false,
        ...over,
    };
    const utils = render(<CoworkOptionsBar {...props} />);
    return { ...utils, props };
}

/** The panel for an open sheet, addressed by its heading. */
const sheet = (title) => screen.getByRole('dialog', { name: title });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('CoworkOptionsBar — which chips exist', () => {
    it('shows When and Repeat, and keeps the tour anchor on the row', () => {
        const { container } = setup();
        expect(screen.getByTestId('cowork-when-chip')).toBeInTheDocument();
        expect(screen.getByTestId('cowork-repeat-chip')).toBeInTheDocument();
        expect(container.querySelector('[data-tour="cowork-options"]')).not.toBeNull();
    });

    it('adds the agent chip only once there is an agent to pick', () => {
        setup();
        expect(screen.queryByTestId('cowork-agent-chip')).not.toBeInTheDocument();

        setup({ agents: [{ id: 'a1', name: 'Research bee' }] });
        expect(screen.getAllByTestId('cowork-agent-chip')).toHaveLength(1);
    });

    it('wrat: an agentId with an empty agents list hides the choice completely', () => {
        // Exactly what an in-flight /agents/all fetch looks like: the work is
        // pinned to an agent, the chip that would say so is not rendered, and
        // there is no control anywhere to see or clear it.
        setup({ agentId: 'a1', agents: [] });
        expect(screen.queryByTestId('cowork-agent-chip')).not.toBeInTheDocument();
        expect(screen.queryByText('No agent')).not.toBeInTheDocument();
    });
});

describe('CoworkOptionsBar — the When chip', () => {
    it('says "Now" for the now preset, and wears the unset styling', () => {
        setup();
        const chip = screen.getByTestId('cowork-when-chip');
        expect(chip).toHaveTextContent('Now');
        expect(chip.className).toContain('font-medium');
        expect(chip.className).not.toContain('font-semibold');
    });

    it('prints the RESOLVED moment for a preset, not the preset name', () => {
        setup({ when: { presetId: 'in_1h', date: '', time: '' } });
        const chip = screen.getByTestId('cowork-when-chip');
        expect(chip).toHaveTextContent(`Today at ${clockOf(new Date(2026, 8, 6, 13, 0, 0))}`);
        expect(chip).not.toHaveTextContent('In an hour');
        expect(chip.className).toContain('font-semibold');
    });

    it('wrat: "custom" with nothing filled in reads "Pick a moment" while looking set', () => {
        setup({ when: { presetId: 'custom', date: '', time: '' } });
        const chip = screen.getByTestId('cowork-when-chip');
        expect(chip).toHaveTextContent('Pick a moment');
        // Active styling on a chip whose whole message is "you have not picked
        // anything yet".
        expect(chip.className).toContain('font-semibold');
    });

    it('wrat: an unrecognised presetId makes the chip and the sheet disagree', () => {
        setup({ when: { presetId: 'a-week-past-thursday', date: '', time: '' } });
        const chip = screen.getByTestId('cowork-when-chip');
        expect(chip).toHaveTextContent('Pick a moment');

        fireEvent.click(chip);
        const options = within(sheet('When should this run?')).getAllByRole('option');
        const selected = options.filter(o => o.getAttribute('aria-selected') === 'true');
        // The sheet falls back to WHEN_PRESETS[0] and ticks "Run now" — the
        // chip beside it insists nothing has been picked.
        expect(selected).toHaveLength(1);
        expect(selected[0]).toHaveTextContent('Run now');
    });

    it('lists every preset, in order, with the current one ticked', () => {
        setup({ when: { presetId: 'tonight', date: '', time: '' } });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));

        const panel = sheet('When should this run?');
        expect(panel).toHaveTextContent('Bee Flow delivers the result to your notifications.');
        const options = within(screen.getByRole('listbox', { name: 'When' })).getAllByRole('option');
        // The hint is glued straight onto the label in the accessible name —
        // there is no separator between "Tonight" and "18:00".
        expect(options.map(o => o.textContent))
            .toEqual(WHEN_PRESETS.map(p => `${p.label}${p.hint || ''}`));
        expect(options[2]).toHaveAttribute('aria-selected', 'true');
        expect(options[0]).toHaveAttribute('aria-selected', 'false');
    });

    it('picking a preset reports it and shuts the sheet', () => {
        const { props } = setup({ when: { presetId: 'now', date: '', time: '' } });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.click(within(sheet('When should this run?')).getByText('Tomorrow morning'));

        expect(props.onWhenChange).toHaveBeenCalledWith({ presetId: 'tomorrow', date: '', time: '' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('"Pick a moment…" seeds date and time from the current choice and keeps the sheet open', () => {
        const { props } = setup({ when: { presetId: 'in_1h', date: '', time: '' } });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.click(within(sheet('When should this run?')).getByText('Pick a moment…'));

        expect(props.onWhenChange).toHaveBeenCalledWith({
            presetId: 'custom', date: '2026-09-06', time: '13:00',
        });
        expect(sheet('When should this run?')).toBeInTheDocument();
    });

    it('wrat: choosing "Pick a moment…" throws away every other key on `when`', () => {
        // The other branch spreads `...when`; this one builds a fresh object,
        // so anything a caller keeps alongside presetId/date/time is dropped
        // the moment the user opens the custom inputs.
        const { props } = setup({
            when: { presetId: 'in_1h', date: '', time: '', timezone: 'Europe/Amsterdam' },
        });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.click(within(sheet('When should this run?')).getByText('Pick a moment…'));

        const arg = props.onWhenChange.mock.calls[0][0];
        expect(Object.keys(arg).sort()).toEqual(['date', 'presetId', 'time']);
        expect(arg.timezone).toBeUndefined();
    });

    it('shows the date and time inputs only in custom mode, and reports each edit', () => {
        const { props, rerender } = setup({ when: { presetId: 'in_1h', date: '', time: '' } });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        expect(screen.queryByTestId('cowork-when-date')).not.toBeInTheDocument();

        rerender(
            <CoworkOptionsBar
                {...props}
                when={{ presetId: 'custom', date: '2026-09-06', time: '13:00' }}
            />,
        );
        fireEvent.change(screen.getByTestId('cowork-when-date'), { target: { value: '2026-12-24' } });
        expect(props.onWhenChange).toHaveBeenLastCalledWith({
            presetId: 'custom', date: '2026-12-24', time: '13:00',
        });

        fireEvent.change(screen.getByTestId('cowork-when-time'), { target: { value: '07:15' } });
        expect(props.onWhenChange).toHaveBeenLastCalledWith({
            presetId: 'custom', date: '2026-09-06', time: '07:15',
        });
    });

    it('a filled-in custom moment reaches the chip', () => {
        setup({ when: { presetId: 'custom', date: '2026-09-07', time: '07:15' } });
        expect(screen.getByTestId('cowork-when-chip'))
            .toHaveTextContent(`Tomorrow at ${clockOf(new Date(2026, 8, 7, 7, 15, 0))}`);
    });
});

describe('CoworkOptionsBar — the Repeat chip', () => {
    it('says "Once" and stays unset when there is no interval', () => {
        setup();
        const chip = screen.getByTestId('cowork-repeat-chip');
        expect(chip).toHaveTextContent('Once');
        expect(chip.className).toContain('font-medium');
    });

    it('names a known interval and marks the chip set', () => {
        setup({ repeatInterval: 'weekly' });
        const chip = screen.getByTestId('cowork-repeat-chip');
        expect(chip).toHaveTextContent('Every week');
        expect(chip.className).toContain('font-semibold');
    });

    it('wrat: an interval the option list does not know is printed raw', () => {
        setup({ repeatInterval: 'fortnightly' });
        expect(screen.getByTestId('cowork-repeat-chip')).toHaveTextContent('fortnightly');

        fireEvent.click(screen.getByTestId('cowork-repeat-chip'));
        const options = within(sheet('How often?')).getAllByRole('option');
        // Nothing is ticked, so opening the sheet cannot tell you what you have.
        expect(options.every(o => o.getAttribute('aria-selected') === 'false')).toBe(true);
    });

    it('offers the full server interval set, Once first, with the current one ticked', () => {
        setup({ repeatInterval: 'monthly' });
        fireEvent.click(screen.getByTestId('cowork-repeat-chip'));

        const panel = sheet('How often?');
        expect(panel).toHaveTextContent('Repeating work keeps running until you pause it.');
        const options = within(screen.getByRole('listbox', { name: 'Repeat' })).getAllByRole('option');
        expect(options.map(o => o.textContent.trim())).toEqual(COWORK_REPEAT_OPTIONS.map(o => o.label));
        expect(options[0]).toHaveTextContent('Once');
        expect(options[6]).toHaveAttribute('aria-selected', 'true');
    });

    it('picking an interval reports its VALUE, not its label, and closes', () => {
        const { props } = setup();
        fireEvent.click(screen.getByTestId('cowork-repeat-chip'));
        fireEvent.click(within(sheet('How often?')).getByText('Every weekday'));

        expect(props.onRepeatChange).toHaveBeenCalledWith('weekdays');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('"Once" reports the empty string', () => {
        const { props } = setup({ repeatInterval: 'daily' });
        fireEvent.click(screen.getByTestId('cowork-repeat-chip'));
        fireEvent.click(within(sheet('How often?')).getByText('Once'));
        expect(props.onRepeatChange).toHaveBeenCalledWith('');
    });
});

describe('CoworkOptionsBar — the agent chip', () => {
    const AGENTS = [
        { id: 'a1', name: 'Research bee', description: 'Reads and summarises' },
        { id: 'a2', name: '' },
    ];

    it('says "No agent" until one is picked', () => {
        setup({ agents: AGENTS });
        const chip = screen.getByTestId('cowork-agent-chip');
        expect(chip).toHaveTextContent('No agent');
        expect(chip.className).toContain('font-medium');
    });

    it('names the picked agent and marks the chip set', () => {
        setup({ agents: AGENTS, agentId: 'a1' });
        const chip = screen.getByTestId('cowork-agent-chip');
        expect(chip).toHaveTextContent('Research bee');
        expect(chip.className).toContain('font-semibold');
    });

    it('wrat: an agentId that is not in the list silently reads as "No agent"', () => {
        setup({ agents: AGENTS, agentId: 'deleted-agent' });
        const chip = screen.getByTestId('cowork-agent-chip');
        expect(chip).toHaveTextContent('No agent');
        expect(chip.className).toContain('font-medium');

        fireEvent.click(chip);
        const options = within(sheet('Who does the work?')).getAllByRole('option');
        // And the sheet ticks nothing at all — not the agents, and not even
        // the "No agent" row the chip is claiming. The stored agentId is
        // still set; no control on screen admits it exists.
        expect(options[0]).toHaveTextContent('No agent');
        expect(options.every(o => o.getAttribute('aria-selected') === 'false')).toBe(true);
    });

    it('puts "No agent" at the top and falls back to "Untitled agent" for a nameless one', () => {
        setup({ agents: AGENTS, agentId: 'a1' });
        fireEvent.click(screen.getByTestId('cowork-agent-chip'));

        const panel = sheet('Who does the work?');
        expect(panel).toHaveTextContent('An agent brings its own skills, knowledge and connected apps.');
        const options = within(screen.getByRole('listbox', { name: 'Run as agent' })).getAllByRole('option');
        expect(options).toHaveLength(3);
        expect(options[0]).toHaveTextContent('No agentRuns as a plain prompt');
        expect(options[1]).toHaveTextContent('Research beeReads and summarises');
        expect(options[1]).toHaveAttribute('aria-selected', 'true');
        expect(options[2]).toHaveTextContent('Untitled agent');
    });

    it('picking an agent, and clearing it again', () => {
        const { props } = setup({ agents: AGENTS });
        fireEvent.click(screen.getByTestId('cowork-agent-chip'));
        fireEvent.click(within(sheet('Who does the work?')).getByText('Research bee'));
        expect(props.onAgentChange).toHaveBeenCalledWith('a1');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        fireEvent.click(screen.getByTestId('cowork-agent-chip'));
        fireEvent.click(within(sheet('Who does the work?')).getByText('No agent'));
        expect(props.onAgentChange).toHaveBeenLastCalledWith('');
    });
});

describe('CoworkOptionsBar — sheet behaviour', () => {
    it('keeps at most one sheet open', () => {
        setup({ agents: [{ id: 'a1', name: 'Research bee' }] });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        expect(screen.getAllByRole('dialog')).toHaveLength(1);

        fireEvent.click(screen.getByTestId('cowork-repeat-chip'));
        const dialogs = screen.getAllByRole('dialog');
        expect(dialogs).toHaveLength(1);
        expect(dialogs[0].getAttribute('aria-label')).toBe('How often?');
    });

    it('Escape closes it', () => {
        setup();
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('a mousedown outside closes it', () => {
        setup();
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.mouseDown(document.body);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('a mousedown inside leaves it open', () => {
        setup();
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.mouseDown(sheet('When should this run?'));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('wrat: the chip cannot close its own sheet with a real mouse', () => {
        // A real press is mousedown-then-click. The outside-mousedown handler
        // closes the sheet first (the chip is not inside the panel), so by the
        // time the click lands, openSheet is already null and the toggle
        // re-opens it. Only a synthetic click-without-mousedown closes it.
        setup();
        const chip = screen.getByTestId('cowork-when-chip');
        fireEvent.click(chip);
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        fireEvent.mouseDown(chip);
        fireEvent.click(chip);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
});

describe('CoworkOptionsBar — where the panel opens', () => {
    it('opens above the chip when there is room', () => {
        const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
        try {
            rect.mockReturnValue({ top: 320, bottom: 720, left: 0, right: 280, width: 280, height: 400, x: 0, y: 320, toJSON: () => ({}) });
            setup();
            fireEvent.click(screen.getByTestId('cowork-when-chip'));
            const panel = sheet('When should this run?');
            expect(panel.className).toContain('bottom-full');
            expect(panel.className).not.toContain('top-full');
        } finally {
            rect.mockRestore();
        }
    });

    it('flips below the chip when the upward placement is clipped', () => {
        const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
        try {
            rect.mockReturnValue({ top: -120, bottom: 0, left: 0, right: 280, width: 280, height: 400, x: 0, y: -120, toJSON: () => ({}) });
            setup();
            fireEvent.click(screen.getByTestId('cowork-when-chip'));
            const panel = sheet('When should this run?');
            expect(panel.className).toContain('top-full');
            expect(panel.className).not.toContain('bottom-full');
        } finally {
            rect.mockRestore();
        }
    });

    it('on a phone it is a bottom sheet with a backdrop that closes it', () => {
        setup({ isMobile: true });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));

        // Routed through Modal on mobile: the dialog itself is the bottom-sheet
        // panel, its parent is the fixed, full-viewport backdrop.
        const panel = sheet('When should this run?');
        const backdrop = panel.parentElement;
        expect(backdrop.className).toContain('fixed');
        expect(backdrop.className).toContain('justify-end');
        expect(panel.className).toContain('rounded-t-2xl');
        expect(panel.className).not.toContain('bottom-full');
        expect(panel.className).not.toContain('top-full');

        fireEvent.mouseDown(backdrop, { target: backdrop, bubbles: true });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
