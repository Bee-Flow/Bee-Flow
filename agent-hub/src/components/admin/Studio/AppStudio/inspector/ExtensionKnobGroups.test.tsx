import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import StyleSection from './StyleSection';
import { earnedKnobGroups } from './extensionKnobGroups';
import { findNode, updateNodeStyle } from '../state/definitionOps';
import { KITCHEN_SINK } from '../state/sampleDefinitions';
import type { AppDefinition, AppNode } from './appDefinition';

const BOX = ['marginTop', 'marginBottom', 'shadow', 'opacity', 'borderWidth', 'borderSides', 'borderColor', 'backgroundColor'];
const nodeOf = (def: AppDefinition, id: string) => findNode(def, id).node as AppNode;

function renderNode(def: AppDefinition, id: string) {
    const onCommit = vi.fn();
    const utils = render(<StyleSection definition={def} node={nodeOf(def, id)} onCommit={onCommit} />);
    return { onCommit, ...utils };
}

describe('extension knob groups in the inspector', () => {
    it('mirrors the server rule: granted by span, withheld from the types that frame their own box', () => {
        const groups = [{ name: 'g', grantedBy: 'span', knobs: ['a', 'span'], withheldFrom: ['button'] }];
        expect(earnedKnobGroups(['span', 'size'], 'stat', groups).map((g) => g.knobs)).toEqual([['a']]);
        expect(earnedKnobGroups(['span'], 'button', groups)).toEqual([]);
        expect(earnedKnobGroups(['padding'], null, groups)).toEqual([]);
        expect(earnedKnobGroups(['span'], 'heading').map((g) => [g.name, g.knobs])).toEqual([['box', BOX]]);
        expect(earnedKnobGroups(['span', 'size', 'align'], 'button')).toEqual([]);
    });

    it('a heading gets a closed Box disclosure, a button none', () => {
        const heading = renderNode(KITCHEN_SINK, 'cmp_headg1');
        expect(heading.getByRole('button', { name: 'Box' })).toBeTruthy();
        expect(heading.container.querySelector('[data-knob-group="box"]')).toBeNull();
        heading.unmount();
        const button = renderNode(KITCHEN_SINK, 'cmp_refre1');
        expect(button.queryByRole('button', { name: 'Box' })).toBeNull();
    });

    it('commits the knobs it sets, and Theme or Reset take them out again', async () => {
        const user = userEvent.setup();
        const { onCommit, getByRole, getByLabelText, rerender } = renderNode(KITCHEN_SINK, 'cmp_headg1');
        await user.click(getByRole('button', { name: 'Box' }));

        await user.click(getByRole('radio', { name: 'Medium' }));
        expect(nodeOf(onCommit.mock.calls[0][0], 'cmp_headg1').style).toMatchObject({ shadow: 'md' });

        await user.selectOptions(getByLabelText('Border sides'), 'left');
        expect(nodeOf(onCommit.mock.calls[1][0], 'cmp_headg1').style?.borderSides).toBe('left');

        // Fill colour set to a role: Theme removes the key instead of writing null.
        const set = updateNodeStyle(KITCHEN_SINK, 'cmp_headg1', { shadow: 'md', backgroundColor: 'success' });
        rerender(<StyleSection definition={set} node={nodeOf(set, 'cmp_headg1')} onCommit={onCommit} />);
        onCommit.mockClear();
        const themes = document.querySelectorAll('[data-knob-group="box"] [role="radio"]');
        const theme = [...themes].filter((el) => el.textContent === 'Theme').pop() as HTMLElement;
        await user.click(theme);
        const cleared = nodeOf(onCommit.mock.calls[0][0], 'cmp_headg1').style as Record<string, unknown>;
        expect(cleared.backgroundColor).toBeUndefined();
        expect(JSON.parse(JSON.stringify(cleared))).not.toHaveProperty('backgroundColor');

        onCommit.mockClear();
        await user.click(getByRole('button', { name: 'Reset' }));
        const reset = JSON.parse(JSON.stringify(nodeOf(onCommit.mock.calls[0][0], 'cmp_headg1').style));
        for (const k of BOX) expect(reset).not.toHaveProperty(k);
        expect(reset.span).toBe(nodeOf(KITCHEN_SINK, 'cmp_headg1').style?.span);
    });
});
