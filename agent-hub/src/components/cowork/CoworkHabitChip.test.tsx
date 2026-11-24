// "You ask this every Monday": the chat's one offer shows when the stream says so, with the day in words, and "Make it a
// cowork" opens Cowork with the message as its brief, never in the address; "Not now" closes it. No network, no module mocked.
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithClient } from '@/test/render';
import CoworkHabitChip from './CoworkHabitChip';
import { takeHandedBrief } from './coworkHandedBrief';

const offer = (detail: object) => act(() => { window.dispatchEvent(new CustomEvent('beeflow:cowork_suggestion', { detail })); });

describe('CoworkHabitChip', () => {
    it('says the day and closes on "Not now"', async () => {
        renderWithClient(<CoworkHabitChip />);
        expect(screen.queryByTestId('cowork-habit-chip')).toBeNull();
        offer({ weekday: 1, brief: 'Which supplier orders are open?' });
        expect(screen.getByTestId('cowork-habit-chip')).toHaveTextContent('You ask this every Monday. Let Cowork do it for you?');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Not now' }));
        expect(screen.queryByTestId('cowork-habit-chip')).toBeNull();
    });

    it('sits under the header, never over the chat composer at the bottom', () => {
        renderWithClient(<CoworkHabitChip />);
        offer({ weekday: 1, brief: 'Which supplier orders are open?' });
        const chip = screen.getByTestId('cowork-habit-chip');
        expect(chip).toHaveClass('top-16');
        expect(chip.className.split(' ').some((c) => c.startsWith('bottom-'))).toBe(false);
    });

    it('ignores an event without a brief', () => {
        renderWithClient(<CoworkHabitChip />);
        offer({ weekday: 1 });
        expect(screen.queryByTestId('cowork-habit-chip')).toBeNull();
    });

    it('opens Cowork with the message as its brief, which never goes into the address and is taken once', async () => {
        renderWithClient(<CoworkHabitChip />);
        offer({ weekday: 1, brief: 'Which orders & invoices?' });
        await userEvent.setup().click(screen.getByRole('button', { name: 'Make it a cowork' }));
        expect(window.location.pathname).toBe('/app/cowork');
        expect(window.location.search).not.toContain('brief');
        expect(takeHandedBrief()).toEqual({ brief: 'Which orders & invoices?', weekday: 1 });
        expect(takeHandedBrief()).toEqual({ brief: '', weekday: null });
    });

    it('a brief an older link left in the address is read once and removed from it', () => {
        window.history.replaceState(null, '', '/app/cowork?brief=Old%20link&tab=runs');
        expect(takeHandedBrief()).toEqual({ brief: 'Old link', weekday: null });
        expect(window.location.search).toBe('?tab=runs');
    });
});
