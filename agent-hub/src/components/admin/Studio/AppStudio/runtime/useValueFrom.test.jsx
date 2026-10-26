import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import AppInputTextarea from './components/AppInputTextarea';
import { RuntimeProvider, DEFAULT_RUNTIME } from './RuntimeContext';

/**
 * `valueFrom` is the primitive behind both "AI draft" and "insert canned reply":
 * each writes a variable, the field reads it back. These tests pin the three
 * rules that decide whether it feels helpful or hostile.
 */

function Harness({ initialVars = {} }) {
    const [vars, setVars] = useState(initialVars);
    const node = {
        id: 'cmp_ta',
        type: 'input_textarea',
        props: {
            name: 'reply', label: 'Reply', rows: 4,
            valueFrom: { kind: 'formula', expr: 'vars.draft' },
        },
        style: { span: 12 },
    };
    return (
        <>
            <button type="button" onClick={() => setVars({ draft: 'AI-concept 1' })}>draft one</button>
            <button type="button" onClick={() => setVars({ draft: 'AI-concept 2' })}>draft two</button>
            <button type="button" onClick={() => setVars({})}>clear var</button>
            <button type="button" onClick={() => setVars({ draft: null })}>null var</button>
            {/* No form provider: useFormField degrades to local state outside
                one, which is all this behaviour needs. */}
            <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', scope: { vars } }}>
                <AppInputTextarea node={node} />
            </RuntimeProvider>
        </>
    );
}

describe('valueFrom', () => {
    it('pushes a resolved value into the field', async () => {
        const user = userEvent.setup();
        const { getByText, container } = render(<Harness />);
        const area = container.querySelector('textarea');
        expect(area.value).toBe('');

        await user.click(getByText('draft one'));
        expect(container.querySelector('textarea').value).toBe('AI-concept 1');
    });

    it('lets the user edit afterwards without being overwritten', async () => {
        const user = userEvent.setup();
        // The field re-renders constantly; if every render re-pushed, the draft
        // would be un-editable — which is worse than having no draft button.
        const { getByText, container } = render(<Harness />);
        await user.click(getByText('draft one'));
        const area = container.querySelector('textarea');

        await user.clear(area);
        await user.type(area, 'mijn eigen tekst');
        expect(container.querySelector('textarea').value).toBe('mijn eigen tekst');

        // A re-render with the SAME variable value must leave the edit alone.
        await user.click(getByText('draft one'));
        expect(container.querySelector('textarea').value).toBe('mijn eigen tekst');
    });

    it('a NEW value pushes again', async () => {
        const user = userEvent.setup();
        const { getByText, container } = render(<Harness />);
        await user.click(getByText('draft one'));
        await user.clear(container.querySelector('textarea'));
        await user.type(container.querySelector('textarea'), 'handmatig');
        await user.click(getByText('draft two'));
        expect(container.querySelector('textarea').value).toBe('AI-concept 2');
    });

    it('an unresolved binding never clears what is typed', async () => {
        const user = userEvent.setup();
        // vars.draft resolving to undefined means "no draft yet", not "empty
        // the composer".
        const { getByText, container } = render(<Harness initialVars={{ draft: 'start' }} />);
        expect(container.querySelector('textarea').value).toBe('start');
        await user.clear(container.querySelector('textarea'));
        await user.type(container.querySelector('textarea'), 'getypt');
        await user.click(getByText('clear var'));
        expect(container.querySelector('textarea').value).toBe('getypt');
    });

    it('a resolved NULL never clears what is typed either', async () => {
        const user = userEvent.setup();
        // Only `undefined` used to count as "nothing yet". A record column that
        // is NULL — or a variable explicitly set to null — resolves to null, and
        // it landed a frame after the first paint: the composer was wiped
        // mid-sentence while the query the field was waiting on came back empty.
        const { getByText, container } = render(<Harness initialVars={{ draft: 'start' }} />);
        await user.clear(container.querySelector('textarea'));
        await user.type(container.querySelector('textarea'), 'getypt');
        await user.click(getByText('null var'));
        expect(container.querySelector('textarea').value).toBe('getypt');
    });
});
