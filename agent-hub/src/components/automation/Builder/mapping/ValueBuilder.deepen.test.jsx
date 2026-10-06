import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ValueBuilder from './ValueBuilder';
import { VariablePickerProvider } from './VariablePickerContext';

// A step that already runs once per Gmail result (loop.result); each result
// holds its attachments. Values fictional.
const SAMPLE = {
    loop: {
        result: {
            id: 'm1', subject: 'Factuur',
            attachments: [
                { filename: 'a.pdf', mimeType: 'application/pdf', attachmentId: 'a1', messageId: 'm1' },
                { filename: 'logo.png', mimeType: 'image/png', attachmentId: 'a2', messageId: 'm1' },
            ],
        },
    },
};

function renderEditor({ deepen }) {
    const onChange = vi.fn();
    const handle = { current: null };
    render(
        <VariablePickerProvider groups={[]} previewSample={SAMPLE} stepLabelById={new Map()}>
            <ValueBuilder
                value={{ kind: 'literal', value: '' }}
                onChange={onChange}
                previewSample={SAMPLE}
                expectShape="scalar"
                expectKind="text"
                label="attachmentId"
                onFocusField={(h) => { handle.current = h; }}
                deepenForEach={deepen}
            />
        </VariablePickerProvider>,
    );
    act(() => { screen.getAllByRole('textbox')[0].focus(); });
    return { onChange, insert: (p) => act(() => { handle.current.insert(p); }) };
}

describe('a value from a list inside the item the step already runs over', () => {
    beforeEach(cleanup);

    it('runs the step once per attachment instead of joining the ids, and says so', () => {
        const apply = vi.fn(() => ({ undo: vi.fn(), runs: null, orphans: [] }));
        const { onChange, insert } = renderEditor({ deepen: { itemVar: 'result', apply } });
        insert('loop.result.attachments[*].attachmentId');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'ref', path: 'loop.attachment.attachmentId' });
        expect(apply).toHaveBeenCalledWith(
            expect.objectContaining({ fromVar: 'result', listTail: 'attachments', itemVar: 'attachment' }),
            SAMPLE.loop.result.attachments[0],
        );
        expect(screen.getByText(/runs once per attachment/)).toBeTruthy();
    });

    it('names a field that could not move, and Undo restores the step', async () => {
        const undo = vi.fn();
        const apply = vi.fn(() => ({ undo, runs: null, orphans: ['subject'] }));
        const { insert } = renderEditor({ deepen: { itemVar: 'result', apply } });
        insert('loop.result.attachments[*].attachmentId');
        expect(screen.getByText(/Check subject/)).toBeTruthy();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }));
        expect(undo).toHaveBeenCalled();
    });

    it('leaves a plain field of the item alone', () => {
        const apply = vi.fn();
        const { onChange, insert } = renderEditor({ deepen: { itemVar: 'result', apply } });
        insert('loop.result.subject');
        expect(apply).not.toHaveBeenCalled();
        expect(onChange.mock.calls.at(-1)[0]).toMatchObject({ kind: 'ref', path: 'loop.result.subject' });
    });
});
