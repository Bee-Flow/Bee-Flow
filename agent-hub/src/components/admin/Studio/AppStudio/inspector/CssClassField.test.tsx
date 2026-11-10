import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import CssClassField, { setNodeCssClass } from './CssClassField';
import { findNode } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';

const base = (cssClass?: string): AppDefinition => ({
    screens: [{ id: 'scr_home', name: 'Home', sections: [{ id: 'sec_main', children: [{ id: 'cmp_title', type: 'heading', props: { text: 'Hi' }, ...(cssClass ? { cssClass } : {}) }] }] }],
} as AppDefinition);

const nodeOf = (definition: AppDefinition) => findNode(definition, 'cmp_title')?.node as AppNode;

function Harness({ initial }: { initial: AppDefinition }) {
    const [definition, setDefinition] = useState(initial);
    return (
        <>
            <CssClassField definition={definition} node={nodeOf(definition)} onCommit={setDefinition} disabled={false} />
            <output data-testid="class">{String(nodeOf(definition).cssClass ?? '(none)')}</output>
        </>
    );
}

describe('CssClassField', () => {
    it('stores a valid name on the node and tells how to style it', async () => {
        render(<Harness initial={base()} />);
        await userEvent.type(screen.getByRole('textbox'), 'hero');
        expect(screen.getByTestId('class').textContent).toBe('hero');
        expect(screen.getByTestId('app-css-class-field').textContent).toContain('.u-hero');
    });

    it('keeps the stored name while what is typed is not a name, and says the rule', async () => {
        render(<Harness initial={base('hero')} />);
        await userEvent.type(screen.getByRole('textbox'), ' Big');
        expect(screen.getByRole('textbox')).toHaveValue('hero Big');
        expect(screen.getByTestId('class').textContent).toBe('hero');
        expect(screen.getByTestId('app-css-class-field').textContent).toContain('Start with a lower-case letter');
    });

    it('removes the key when the field is emptied', async () => {
        render(<Harness initial={base('hero')} />);
        await userEvent.clear(screen.getByRole('textbox'));
        expect(screen.getByTestId('class').textContent).toBe('(none)');
    });

    it('setNodeCssClass leaves the definition it was given alone', () => {
        const definition = base();
        const next = setNodeCssClass(definition, 'cmp_title', 'hero');
        expect(nodeOf(next).cssClass).toBe('hero');
        expect('cssClass' in nodeOf(definition)).toBe(false);
        expect('cssClass' in nodeOf(setNodeCssClass(next, 'cmp_title', ''))).toBe(false);
        expect(setNodeCssClass(definition, 'cmp_missing', 'hero')).toBe(definition);
    });
});
