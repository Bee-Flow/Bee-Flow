import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiDraftPanel, { isBlankForm } from './AiDraftPanel';

/**
 * "Build it with AI": a blank form takes a brief and is drafted whole; a
 * form with questions takes a request and sends the current questions along;
 * the draft lands in the editor through onApply and NOTHING is posted to the
 * routine; Undo restores what the editor held; every server refusal has its
 * own sentence; a parked brief runs once by itself.
 */

const { api } = vi.hoisted(() => ({ api: { draftForm: vi.fn() } }));
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => api }));

const BLANK = { title: 'Get in touch', fields: [{ name: 'name' }, { name: 'email' }, { name: 'message' }] };
const FILLED = { title: 'Feedback', collect: true, fields: [{ name: 'email', type: 'email', label: 'Your e-mail' }] };
const DRAFT = { form: { title: 'Vacation request', fields: [{ name: 'your_name', type: 'text', label: 'Your name' }, { name: 'first_day', type: 'date', label: 'First day' }] }, notes: null };

beforeEach(() => { cleanup(); vi.clearAllMocks(); api.draftForm.mockResolvedValue({ draft: DRAFT, mode: 'create' }); });

describe('isBlankForm', () => {
    it('no questions, or the product\'s own three placeholders, is blank; anything else is not', () => {
        expect(isBlankForm({ fields: [] })).toBe(true);
        expect(isBlankForm(BLANK)).toBe(true);
        expect(isBlankForm({ ...BLANK, title: 'Feedback' })).toBe(false);
        expect(isBlankForm(FILLED)).toBe(false);
    });
});

describe('<AiDraftPanel>', () => {
    it('a blank form: a brief in, the whole form applied, the current form sent for its theme and collect', async () => {
        const onApply = vi.fn();
        const { rerender } = render(<AiDraftPanel form={BLANK} onApply={onApply} />);
        expect(screen.queryByRole('radiogroup')).toBeNull();
        expect(screen.getByTestId('form-ai-run')).toBeDisabled();
        fireEvent.change(screen.getByTestId('form-ai-text'), { target: { value: 'A vacation request form' } });
        fireEvent.click(screen.getByTestId('form-ai-run'));
        await waitFor(() => expect(onApply).toHaveBeenCalledWith(DRAFT.form));
        expect(api.draftForm).toHaveBeenCalledWith({ mode: 'create', brief: 'A vacation request form', current: BLANK });
        expect((await screen.findByTestId('form-ai-done')).textContent).toContain('2 questions drafted');
        // the parent adopts the draft; the next ask is a change
        rerender(<AiDraftPanel form={DRAFT.form} onApply={onApply} />);
        expect(screen.getByRole('button', { name: /Change the questions/ })).toBeTruthy();
    });

    it('a form with questions: a request in, the current questions along, in revise mode by default', async () => {
        const onApply = vi.fn();
        render(<AiDraftPanel form={FILLED} onApply={onApply} />);
        expect(screen.getByRole('radio', { name: 'Change the current questions' }).getAttribute('aria-checked')).toBe('true');
        fireEvent.change(screen.getByTestId('form-ai-text'), { target: { value: 'add a phone number' } });
        fireEvent.click(screen.getByTestId('form-ai-run'));
        await waitFor(() => expect(onApply).toHaveBeenCalled());
        expect(api.draftForm).toHaveBeenCalledWith({ mode: 'revise', note: 'add a phone number', current: FILLED });
    });

    it('"Start over" on a filled form sends a brief instead', async () => {
        render(<AiDraftPanel form={FILLED} onApply={vi.fn()} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Start over from a description' }));
        fireEvent.change(screen.getByTestId('form-ai-text'), { target: { value: 'something new' } });
        fireEvent.click(screen.getByTestId('form-ai-run'));
        await waitFor(() => expect(api.draftForm).toHaveBeenCalledWith({ mode: 'create', brief: 'something new', current: FILLED }));
    });

    it('Undo puts back exactly what the editor held before the draft', async () => {
        const onApply = vi.fn();
        render(<AiDraftPanel form={FILLED} onApply={onApply} />);
        fireEvent.change(screen.getByTestId('form-ai-text'), { target: { value: 'shorter' } });
        fireEvent.click(screen.getByTestId('form-ai-run'));
        await screen.findByTestId('form-ai-done');
        fireEvent.click(screen.getByTestId('form-ai-undo'));
        expect(onApply).toHaveBeenLastCalledWith(FILLED);
        expect(onApply.mock.calls[1][0]).not.toBe(FILLED); // a copy, not the same object
        expect(screen.queryByTestId('form-ai-undo')).toBeNull();
    });

    it('every refusal has its own sentence, and the box keeps its text to try again', async () => {
        render(<AiDraftPanel form={BLANK} onApply={vi.fn()} />);
        const cases = [
            [{ code: 'no_model', status: 503 }, /No AI model is set up/],
            [{ code: 'ai_unusable', status: 502 }, /did not return a usable form/],
            [{ status: 429 }, /Too many drafts/],
            [{ message: 'boom' }, /boom/],
        ];
        for (const [err, re] of cases) {
            api.draftForm.mockRejectedValueOnce(Object.assign(new Error(err.message || 'x'), err));
            fireEvent.change(screen.getByTestId('form-ai-text'), { target: { value: 'a brief' } });
            fireEvent.click(screen.getByTestId('form-ai-run'));
            expect((await screen.findByRole('alert')).textContent).toMatch(re);
            expect(screen.getByTestId('form-ai-text').value).toBe('a brief');
        }
    });

    it('a parked brief runs once by itself', async () => {
        const onApply = vi.fn();
        const { rerender } = render(<AiDraftPanel form={BLANK} onApply={onApply} seed="A vacation request form" />);
        await waitFor(() => expect(api.draftForm).toHaveBeenCalledWith({ mode: 'create', brief: 'A vacation request form', current: BLANK }));
        await waitFor(() => expect(onApply).toHaveBeenCalled());
        rerender(<AiDraftPanel form={DRAFT.form} onApply={onApply} seed="A vacation request form" />);
        expect(api.draftForm).toHaveBeenCalledTimes(1);
    });
});
