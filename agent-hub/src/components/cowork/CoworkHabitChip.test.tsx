// "You ask this every Monday": the chat's one offer shows when the stream says so, with the day in words, and "Make it a
// cowork" opens Cowork with the message as its brief; "Not now" closes it. No network, no module mocked.
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithClient } from '@/test/render';
import CoworkHabitChip, { coworkWithBrief } from './CoworkHabitChip';

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

    it('ignores an event without a brief', () => {
        renderWithClient(<CoworkHabitChip />);
        offer({ weekday: 1 });
        expect(screen.queryByTestId('cowork-habit-chip')).toBeNull();
    });

    it('opens Cowork with the message as its brief', () => {
        expect(coworkWithBrief('Which orders & invoices?')).toBe('/app/cowork?brief=Which%20orders%20%26%20invoices%3F');
    });
});
