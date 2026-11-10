/**
 * The one-line rename and create boxes of the sidebar: the Enter that confirms
 * an IME candidate (Japanese, Chinese, Korean) belongs to the IME and must not
 * save a half-composed name. Safari has already ended the composition by that
 * keydown and only reports keyCode 229.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConvRow from './ConvRow';
import CreateLabelInline from './CreateLabelInline';
import EditLabelInline from './EditLabelInline';
import type { TranslateFn } from '@/hooks/useTranslation';

const t = ((key: string, fallback?: string) => fallback || key) as TranslateFn;

/** The candidate-confirming Enter, the way Chrome and the way Safari report it. */
function imeEnter(el: HTMLElement) {
    fireEvent.keyDown(el, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 });
}

describe('sidebar inline inputs and the IME', () => {
    it('ConvRow: the rename box stays open and nothing is saved', async () => {
        const user = userEvent.setup();
        const onRename = vi.fn();
        const conv = { id: 'c1', title: 'Plan', updated_at: null } as unknown as React.ComponentProps<typeof ConvRow>['conv'];
        render(<ConvRow conv={conv} t={t} active={false} selectConv={vi.fn()} deleteConv={vi.fn()} onRenameConversation={onRename} />);
        await user.click(screen.getByTitle('Options'));
        await user.click(screen.getByRole('button', { name: /rename/i }));
        const box = screen.getByDisplayValue('Plan');
        await user.clear(box);
        await user.type(box, '計画');

        imeEnter(box);
        expect(onRename).not.toHaveBeenCalled();
        expect(screen.getByDisplayValue('計画')).toBeTruthy();

        await user.keyboard('{Enter}');
        expect(onRename).toHaveBeenCalledWith(conv, '計画');
    });

    it('EditLabelInline: saves on a real Enter only', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        const onCancel = vi.fn();
        render(<EditLabelInline label={{ id: 'l1', name: 'Work', color: '#111111' }} onSave={onSave} onCancel={onCancel} t={t} />);
        const box = screen.getByDisplayValue('Work');
        await user.clear(box);
        await user.type(box, '仕事');

        imeEnter(box);
        expect(onSave).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();

        await user.keyboard('{Enter}');
        expect(onSave).toHaveBeenCalledWith('l1', { name: '仕事', color: '#111111' });
    });

    it('CreateLabelInline: creates on a real Enter only', async () => {
        const user = userEvent.setup();
        const onCreateLabel = vi.fn();
        render(<CreateLabelInline onCreateLabel={onCreateLabel} t={t} />);
        await user.click(screen.getByRole('button'));
        const box = screen.getByRole('textbox');
        await user.type(box, '仕事');

        imeEnter(box);
        expect(onCreateLabel).not.toHaveBeenCalled();

        await user.keyboard('{Enter}');
        expect(onCreateLabel).toHaveBeenCalledWith('仕事', '#6366f1');
    });
});
