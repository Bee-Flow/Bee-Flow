/**
 * Labels and checklist steps are added with Enter. The Enter that confirms an
 * IME candidate belongs to the IME: it must not add a half-composed entry.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChecklistEditor, LabelsInput } from './TaskFields';

/** The candidate-confirming Enter, the way Chrome and the way Safari report it. */
function imeEnter(el: HTMLElement) {
    fireEvent.keyDown(el, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 });
}

describe('TaskFields and the IME', () => {
    it('LabelsInput adds on a real Enter only', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<LabelsInput value={[]} onChange={onChange} disabled={false} />);
        const box = screen.getByRole('combobox');
        await user.type(box, '緊急');

        imeEnter(box);
        expect(onChange).not.toHaveBeenCalled();
        expect(box).toHaveValue('緊急');

        await user.keyboard('{Enter}');
        expect(onChange).toHaveBeenCalledWith(['緊急']);
    });

    it('ChecklistEditor adds on a real Enter only', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<ChecklistEditor value={[]} onChange={onChange} disabled={false} />);
        const box = screen.getByRole('textbox');
        await user.type(box, '確認');

        imeEnter(box);
        expect(onChange).not.toHaveBeenCalled();

        await user.keyboard('{Enter}');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toMatchObject([{ text: '確認', done: false }]);
    });
});
