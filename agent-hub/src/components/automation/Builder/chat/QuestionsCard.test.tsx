/**
 * The card the builder draws for builder_ask_questions: a stepper, one question
 * at a time. Pinned here: the model's inline markdown renders instead of showing
 * its asterisks, the first option is preselected and marked suggested, a click
 * moves on by itself, the keyboard drives it (digits, Enter, Shift+Enter), the
 * "Other" field never leaves a question without an answer, and everything goes
 * out as plain Q/A text plus a structured list in one send.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuestionsCard from './QuestionsCard';

vi.mock('../../../../hooks/useTranslation', () => {
    const t = (_k: string, d: string, p?: Record<string, unknown>) => d.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? `{${k}}`));
    return { default: () => ({ t }), useTranslation: () => ({ t }) };
});

afterEach(cleanup);

const THREE = [
    { id: 'q1', prompt: 'Which **trigger** should start `daily-report`?', options: ['A **webhook** call', 'A schedule'] },
    { id: 'q2', prompt: 'Which channel?', options: ['Email', 'Talk', 'Signal'] },
    { id: 'q3', prompt: 'Send on weekends?', options: ['No', 'Yes'] },
];
const checked = (name: string) => (screen.getByRole('radio', { name }) as HTMLInputElement).checked;

describe('QuestionsCard', () => {
    it('renders inline markdown in prompts and options, never the raw marks', () => {
        const { container } = render(<QuestionsCard questions={THREE} onAnswer={vi.fn()} />);
        expect(container.textContent).not.toContain('**');
        expect(container.textContent).not.toContain('`');
        expect(container.querySelector('strong')?.textContent).toBe('trigger');
        expect(container.querySelector('code')?.textContent).toBe('daily-report');
        expect(screen.getByRole('radio', { name: 'A webhook call' })).toBeTruthy();
    });

    it('keeps a list in a prompt inline: no list element, line breaks kept for the CSS', () => {
        const { container } = render(<QuestionsCard questions={[{ id: 'q1', prompt: 'Which one?\n- webhook\n- schedule', options: ['a', 'b'] }]} onAnswer={vi.fn()} />);
        expect(container.querySelector('ul, ol, li')).toBeNull();
        expect(container.querySelector('.whitespace-pre-line')).toBeTruthy();
        expect(container.querySelector('.break-words')).toBeTruthy();
    });

    it('one question has no progress chrome and says "Send answer"', () => {
        render(<QuestionsCard questions={[THREE[1]]} onAnswer={vi.fn()} />);
        expect(screen.queryByText(/Question 1 of/)).toBeNull();
        expect(screen.queryByRole('button', { name: /go to question/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
        expect(screen.getByRole('button', { name: 'Send answer' })).toBeTruthy();
    });

    it('with several questions it shows one at a time, preselects the first option and marks it suggested', () => {
        render(<QuestionsCard questions={THREE} onAnswer={vi.fn()} />);
        expect(screen.getByText('Question 1 of 3')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Go to question 1' }).getAttribute('aria-current')).toBe('step');
        expect(screen.getByRole('button', { name: 'Go to question 2' }).getAttribute('aria-current')).toBeNull();
        expect(checked('A webhook call')).toBe(true);
        expect(checked('A schedule')).toBe(false);
        expect(screen.getByText('suggested')).toBeTruthy();
        expect(screen.queryByRole('radio', { name: 'Talk' })).toBeNull();     // question 2 is not on screen
    });

    it('a click on an option moves to the next question after a beat', async () => {
        const user = userEvent.setup();
        render(<QuestionsCard questions={THREE} onAnswer={vi.fn()} />);
        await user.click(screen.getByRole('radio', { name: 'A schedule' }));
        expect(screen.getByText('Question 1 of 3')).toBeTruthy();             // not yet
        await waitFor(() => expect(screen.getByText('Question 2 of 3')).toBeTruthy());
    });

    it('digits pick an option, Enter goes next, Shift+Enter goes back and keeps the earlier pick', async () => {
        const user = userEvent.setup();
        render(<QuestionsCard questions={THREE} onAnswer={vi.fn()} />);
        screen.getByTestId('questions-card').focus();
        await user.keyboard('2');                                             // picks "A schedule", then moves on
        await waitFor(() => expect(screen.getByText('Question 2 of 3')).toBeTruthy());
        await user.keyboard('{Enter}');                                       // Next, keeps "Email"
        expect(screen.getByText('Question 3 of 3')).toBeTruthy();
        await user.keyboard('{Shift>}{Enter}{/Shift}');
        expect(screen.getByText('Question 2 of 3')).toBeTruthy();
        await user.keyboard('{Shift>}{Enter}{/Shift}');
        expect(screen.getByText('Question 1 of 3')).toBeTruthy();
        expect(checked('A schedule')).toBe(true);
    });

});

describe('QuestionsCard — sending', () => {
    it('Other: digits typed in the field are text, and the typed answer is what is sent', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<QuestionsCard questions={[THREE[1]]} onAnswer={onAnswer} />);
        await user.keyboard('4');                                            // one past the options: focuses Other
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Other…' }));
        await user.keyboard('Signal 2');
        expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Signal 2');
        expect(checked('Email')).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Send answer' }));
        expect(onAnswer).toHaveBeenCalledWith('Q: Which channel?\nA: Signal 2', [{ prompt: 'Which channel?', answer: 'Signal 2', suggested: false }]);
    });

    it('an empty Other field never leaves the question unanswered, and picking an option wins over earlier typing', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<QuestionsCard questions={[THREE[1]]} onAnswer={onAnswer} />);
        await user.click(screen.getByRole('textbox'));
        expect(checked('Email')).toBe(true);
        await user.type(screen.getByRole('textbox'), 'Fax');
        await user.click(screen.getByRole('radio', { name: 'Talk' }));
        expect(checked('Talk')).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Send answer' }));
        expect(onAnswer.mock.calls[0][1]).toEqual([{ prompt: 'Which channel?', answer: 'Talk', suggested: false }]);
    });

    it('the last step sends once, with every Q/A in order', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<QuestionsCard questions={THREE} onAnswer={onAnswer} />);
        await user.click(screen.getByRole('button', { name: 'Next' }));
        await user.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Send answers' }));
        expect(onAnswer).toHaveBeenCalledTimes(1);
        const [text, list] = onAnswer.mock.calls[0];
        expect(text).toBe('Q: Which **trigger** should start `daily-report`?\nA: A **webhook** call\n\nQ: Which channel?\nA: Email\n\nQ: Send on weekends?\nA: No');
        expect(list.map((a: { suggested: boolean }) => a.suggested)).toEqual([true, true, true]);
    });

    it('"Use suggestions for the rest" sends at once, keeping what was picked and filling the questions not yet seen', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<QuestionsCard questions={THREE} onAnswer={onAnswer} />);
        await user.click(screen.getByRole('button', { name: 'Use suggestions for the rest' }));
        expect(onAnswer).toHaveBeenCalledTimes(1);
        expect(onAnswer.mock.calls[0][1].map((a: { answer: string }) => a.answer)).toEqual(['A **webhook** call', 'Email', 'No']);
    });

    it('the segmented bar jumps to a question', async () => {
        const user = userEvent.setup();
        render(<QuestionsCard questions={THREE} onAnswer={vi.fn()} />);
        await user.click(screen.getByRole('button', { name: 'Go to question 3' }));
        expect(screen.getByText('Question 3 of 3')).toBeTruthy();
    });

    it('is not disabled unless asked to be, and dims and disables when running', () => {
        const { container, rerender } = render(<QuestionsCard questions={THREE} onAnswer={vi.fn()} />);
        expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
        expect(container.querySelector('fieldset[disabled]')).toBeNull();
        rerender(<QuestionsCard questions={THREE} running onAnswer={vi.fn()} />);
        expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
        expect(container.querySelector('fieldset[disabled]')).toBeTruthy();
    });
});
