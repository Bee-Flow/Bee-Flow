import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { withExperiment } from './ExperimentCard';
import type { BlockEditorProps } from './editorProps';

function Title({ data, onChange }: BlockEditorProps<{ title?: string }>) {
    return <input aria-label="Title" value={data?.title || ''} onChange={e => onChange({ ...data, title: e.target.value })} />;
}
const Editor = withExperiment(Title);

const openCard = async () => {
    // The card remembers being open (persistKey), so only open it when it is closed.
    if (!screen.queryByText('Test an alternative for this block')) await userEvent.click(screen.getByText('A/B test'));
};
const clickToggle = async () => {
    const knob = screen.getByText('Test an alternative for this block').parentElement?.querySelector('span.relative');
    await userEvent.click(knob as Element);
};

describe('withExperiment', () => {
    it('turns an experiment on with a valid name and an empty alternative, and off again without leaving fields behind', async () => {
        const onChange = vi.fn();
        const { rerender } = render(<Editor data={{ title: 'Control' }} onChange={onChange} />);
        await openCard();
        await clickToggle();
        const on = onChange.mock.calls[0][0];
        expect(on.title).toBe('Control');
        expect(on.abKey).toMatch(/^ab_[a-z0-9]+$/);
        expect(on.abAlt).toEqual({});
        expect(on.abShare).toBe(50);

        onChange.mockClear();
        rerender(<Editor data={on} onChange={onChange} />);
        await clickToggle();
        expect(onChange).toHaveBeenCalledWith({ title: 'Control' });
    });

    it('edits the alternative with the block\'s own editor and stores only what differs', async () => {
        const onChange = vi.fn();
        const data = { title: 'Control', abKey: 'hero', abAlt: {}, abShare: 50 };
        render(<Editor data={data} onChange={onChange} />);
        await openCard();
        await userEvent.click(screen.getByRole('button', { name: 'Alternative' }));
        const inputs = screen.getAllByLabelText('Title');
        await userEvent.type(inputs[inputs.length - 1], '!');
        const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
        expect(last.title).toBe('Control');
        expect(last.abAlt).toEqual({ title: 'Control!' });
    });
});

describe('which block editors get the A/B card', () => {
    it('leaves it off the form and customer-support editors, whose submissions the server checks against the published block', async () => {
        const { BLOCK_EDITORS } = await import('./catalogue');
        expect(BLOCK_EDITORS.form.component).not.toBe(BLOCK_EDITORS.hero.component);
        expect(BLOCK_EDITORS.form.component.name).not.toBe('EditorWithExperiment');
        expect(BLOCK_EDITORS['customer-support'].component.name).not.toBe('EditorWithExperiment');
        expect(BLOCK_EDITORS.hero.component.name).toBe('EditorWithExperiment');
    });
});
