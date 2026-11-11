import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import StyleWhenRules, { editableRuleKnobs, setNodeStyleWhen } from './StyleWhenRules';
import { findNode } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';

const rule = (expr: string, style: Record<string, unknown>) => ({ when: { kind: 'formula', expr }, style });

function appWith(node: Partial<AppNode>): AppDefinition {
    const stat = { id: 'cmp_spent', type: 'stat', props: { label: 'Spent' }, ...node };
    return { screens: [{ id: 'scr_a', name: 'A', sections: [{ id: 'sec_a', children: [stat] }] }] } as AppDefinition;
}

const spentOf = (definition: AppDefinition) => findNode(definition, 'cmp_spent')?.node as AppNode;

function Editor({ start }: { start: AppDefinition }) {
    const [def, setDef] = useState(start);
    return (
        <div>
            <StyleWhenRules definition={def} node={spentOf(def)} onCommit={setDef} disabled={false} />
            <pre data-testid="stored">{JSON.stringify(spentOf(def).styleWhen ?? null)}</pre>
        </div>
    );
}

const stored = () => JSON.parse(screen.getByTestId('stored').textContent || 'null');

describe('StyleWhenRules', () => {
    it('offers the text colour, fill and weight a type has, and nothing for a type without look knobs', () => {
        expect(editableRuleKnobs('stat')).toContain('color');
        expect(editableRuleKnobs('stat')).toContain('backgroundColor');
        expect(editableRuleKnobs('spacer')).not.toContain('color');
    });

    it('commits a rule once it has a formula and a knob', async () => {
        const user = userEvent.setup();
        render(<Editor start={appWith({})} />);
        await user.click(screen.getByRole('button', { name: 'Add a rule' }));
        const card = screen.getByTestId('app-style-when-rule');
        await user.type(within(card).getByRole('textbox'), 'vars.n > 3');
        expect(stored()).toBeNull();
        await user.selectOptions(within(card).getByRole('combobox', { name: 'Text colour' }), 'danger');
        expect(stored()).toEqual([rule('vars.n > 3', { color: 'danger' })]);
    });

    it('keeps knobs it does not draw, and removing the last rule removes the key', async () => {
        const user = userEvent.setup();
        render(<Editor start={appWith({ styleWhen: [rule('vars.n > 1', { color: 'info', shadow: 'md' })] })} />);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Fill colour' }), 'warning');
        expect(stored()).toEqual([rule('vars.n > 1', { color: 'info', shadow: 'md', backgroundColor: 'warning' })]);
        await user.click(screen.getByRole('button', { name: 'Remove rule' }));
        expect(stored()).toBeNull();
    });

    it('setNodeStyleWhen leaves the definition it was given alone', () => {
        const before = appWith({});
        const after = setNodeStyleWhen(before, 'cmp_spent', [rule('true', { color: 'info' })] as never);
        expect(spentOf(after).styleWhen).toHaveLength(1);
        expect('styleWhen' in spentOf(before)).toBe(false);
        expect(setNodeStyleWhen(before, 'cmp_nope', [])).toBe(before);
    });
});
