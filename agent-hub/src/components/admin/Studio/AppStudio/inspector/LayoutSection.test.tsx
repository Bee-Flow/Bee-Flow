import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import LayoutSection from './LayoutSection';
import StyleSection from './StyleSection';
import { knobLabel } from './styleKnobMeta';
import type { AppDefinition } from './appDefinition';

const NO_STYLE: Record<string, unknown> = {};

async function open(type: string | null, knobs: string[], style: Record<string, unknown> = NO_STYLE) {
    const patch = vi.fn();
    const utils = render(<LayoutSection type={type} knobs={knobs} style={style} patch={patch} disabled={false} />);
    await userEvent.click(screen.getByRole('button', { name: /Layout/ }));
    return { patch, ...utils };
}

/** The input of the field with this label (the kit's fields name their input by position, not by id). */
function inputOf(label: string): HTMLInputElement {
    const field = screen.getByText(label).parentElement?.parentElement;
    const input = field?.querySelector('input');
    if (!input) throw new Error(`no input under the label "${label}"`);
    return input;
}
/** Pick a number in the segmented control with this name. */
const pick = (group: string, value: string) => userEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: value }));

describe('LayoutSection', () => {
    it('names its knobs from the knob group files', () => {
        expect(knobLabel('spanMd')).toBe('Width on tablet');
        expect(knobLabel('columns')).toBe('Columns');
        expect(knobLabel('stickyOffset')).toBe('Distance from edge');
    });

    it('a plain node gets the placement fields and no grid fields', async () => {
        const { patch } = await open('heading', ['span', 'align']);
        expect(screen.queryByText('Columns')).toBeNull();
        await userEvent.type(inputOf('Width on tablet'), '4');
        expect(patch).toHaveBeenLastCalledWith({ spanMd: 4 });
        await userEvent.click(screen.getByRole('radio', { name: 'Middle' }));
        expect(patch).toHaveBeenLastCalledWith({ alignSelf: 'center' });
        await pick('Rows', '3');
        expect(patch).toHaveBeenLastCalledWith({ rowSpan: 3 });
    });

    it('the resting value of every control is committed as null, so nothing is stored for it', async () => {
        const { patch } = await open('heading', ['span'], { spanMd: 4, rowSpan: 3, alignSelf: 'center', sticky: 'top', stickyOffset: 2 });
        await userEvent.clear(inputOf('Width on tablet'));
        expect(patch).toHaveBeenLastCalledWith({ spanMd: null });
        await pick('Rows', '1');
        expect(patch).toHaveBeenLastCalledWith({ rowSpan: null });
        await userEvent.click(screen.getByRole('radio', { name: 'Fill' }));
        expect(patch).toHaveBeenLastCalledWith({ alignSelf: null });
        await pick('Distance from edge', '0');
        expect(patch).toHaveBeenLastCalledWith({ stickyOffset: null });
        await userEvent.click(screen.getByRole('radio', { name: 'Off' }));
        expect(patch).toHaveBeenLastCalledWith({ sticky: null, stickyOffset: null });
    });

    it('the distance slider only shows for a sticky node', async () => {
        await open('heading', ['span']);
        expect(screen.queryByText('Distance from edge')).toBeNull();
        expect(screen.getByRole('radiogroup', { name: 'Stick while scrolling' })).toBeTruthy();
    });

    it('a width outside 1..12 clears the knob', async () => {
        const { patch } = await open('heading', ['span']);
        await userEvent.type(inputOf('Width on phone'), '0');
        expect(patch).toHaveBeenLastCalledWith({ spanSm: null });
    });

    it('a section gets the grid fields only', async () => {
        const { patch } = await open(null, ['padding', 'gap', 'background', 'height']);
        expect(screen.queryByText('Width on tablet')).toBeNull();
        await userEvent.type(inputOf('Columns'), '5');
        expect(patch).toHaveBeenLastCalledWith({ columns: 5 });
        await userEvent.click(screen.getByRole('radio', { name: 'Keep' }));
        expect(patch).toHaveBeenLastCalledWith({ responsive: 'manual' });
    });

    it('back at 12 columns, or on Rearrange, the grid knob is cleared', async () => {
        const five = await open(null, ['padding', 'gap'], { columns: 5 });
        await userEvent.clear(inputOf('Columns'));
        expect(five.patch).toHaveBeenLastCalledWith({ columns: null });
        five.unmount();
        const manual = await open(null, ['padding', 'gap'], { responsive: 'manual' });
        await userEvent.click(screen.getByRole('radio', { name: 'Rearrange' }));
        expect(manual.patch).toHaveBeenLastCalledWith({ responsive: null });
    });

    it('a grid with its own columns shows the tablet choice as fixed on Keep', async () => {
        await open('card', ['span', 'gap'], { columns: 4 });
        const keep = screen.getByRole('radio', { name: 'Keep' }) as HTMLButtonElement;
        expect(keep.getAttribute('aria-checked')).toBe('true');
        expect(keep.disabled).toBe(true);
        // A card is a grid AND has a width: both groups.
        expect(inputOf('Width on tablet')).toBeTruthy();
    });

    it('a container without a column grid gets no Columns control', async () => {
        await open('pane', ['span', 'padding', 'gap']);
        expect(screen.queryByText('Columns')).toBeNull();
        expect(inputOf('Width on tablet')).toBeTruthy();
    });

    it('renders nothing for a type with neither a grid nor a width', () => {
        const { container } = render(<LayoutSection type="divider" knobs={['size']} style={NO_STYLE} patch={vi.fn()} disabled={false} />);
        expect(container.innerHTML).toBe('');
    });
});

describe('StyleSection with the layout block', () => {
    const definition = {
        schemaVersion: 2,
        screens: [{
            id: 'scr_a', name: 'A',
            sections: [{ id: 'sec_a', style: { padding: 4, gap: 3, background: 'none' }, children: [
                { id: 'cmp_a', type: 'heading', props: { text: 'Hi' }, style: { span: 6 } },
            ] }],
        }],
    } as unknown as AppDefinition;

    it('commits a section column count into the section style', async () => {
        const onCommit = vi.fn();
        render(<StyleSection definition={definition} sectionId="sec_a" onCommit={onCommit} />);
        await userEvent.click(screen.getByRole('button', { name: /Layout/ }));
        await userEvent.type(inputOf('Columns'), '4');
        const next = onCommit.mock.calls[0][0] as AppDefinition;
        expect((next.screens?.[0].sections?.[0].style as Record<string, unknown>).columns).toBe(4);
    });

    it('commits a node tablet width into the node style', async () => {
        const onCommit = vi.fn();
        const node = definition.screens![0].sections![0].children![0];
        render(<StyleSection definition={definition} node={node} onCommit={onCommit} />);
        await userEvent.click(screen.getByRole('button', { name: /Layout/ }));
        await userEvent.type(inputOf('Width on tablet'), '8');
        const next = onCommit.mock.calls[0][0] as AppDefinition;
        expect(next.screens?.[0].sections?.[0].children?.[0].style).toEqual({ span: 6, spanMd: 8 });
    });
});
