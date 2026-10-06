import { render, screen, cleanup, within } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import RunTabContainer from './RunTabContainer';
import StepOutputTab from './StepOutputTab';

// A run-step row's `bindingWarnings`, as GET /runs/:id/steps returns it.
const MISS = {
    field: 'to', kind: 'ref', path: 'steps.read.output.contact.email', reason: 'missing',
    at: 'steps.read.output.contact', found: 'record', missing: 'email', count: 1,
    description: 'input "to" read steps.read.output.contact.email, but steps.read.output.contact has no "email"',
};
const read = { id: 'read', type: 'action', label: 'Read the purchasing inbox' };
const mail = { id: 'mail', type: 'action', label: 'Send the reply' };
const definition = {
    trigger: { id: 't1', type: 'trigger', kind: 'manual' },
    steps: [read, mail],
    edges: [{ from: 't1', to: 'read' }, { from: 'read', to: 'mail' }],
};

beforeEach(() => cleanup());

describe('the step output says which mappings found nothing', () => {
    it('a green step with an empty input: the block names the input and the source field', () => {
        render(<RunTabContainer step={mail} runStep={{ status: 'success', output: { sent: true }, bindingWarnings: [MISS] }} definition={definition} />);
        const block = screen.getByTestId('output-binding-warnings');
        expect(within(block).getByText('Mappings that found nothing')).toBeTruthy();
        // The step's label from the definition, never its id or the path.
        expect(block.textContent).toContain('Read the purchasing inbox ▸ Contact ▸ Email');
        expect(block.textContent).not.toContain('steps.read');
    });

    it('a failed step shows it beside the error card: often it is the reason', () => {
        render(
            <RunTabContainer
                step={mail}
                runStep={{ status: 'error', output: null, error: 'to is required', bindingWarnings: [MISS] }}
                definition={definition}
            />,
        );
        expect(screen.getByTestId('output-error-card')).toBeTruthy();
        expect(screen.getByTestId('output-binding-warnings')).toBeTruthy();
    });

    it('nothing missed, nothing shown', () => {
        render(<RunTabContainer step={mail} runStep={{ status: 'success', output: { sent: true }, bindingWarnings: null }} definition={definition} />);
        expect(screen.queryByTestId('output-binding-warnings')).toBeNull();
    });

    it('a poll that only adds the warnings still re-renders the column', () => {
        const row = { status: 'success', output: { sent: true } };
        const { rerender } = render(<RunTabContainer step={mail} runStep={row} definition={definition} />);
        expect(screen.queryByTestId('output-binding-warnings')).toBeNull();
        rerender(<RunTabContainer step={mail} runStep={{ ...row, bindingWarnings: [MISS] }} definition={definition} />);
        expect(screen.getByTestId('output-binding-warnings')).toBeTruthy();
    });

    it('StepOutputTab on its own: without a label map the step still reads as a step', () => {
        render(<StepOutputTab liveOutput={{ sent: true }} bindingWarnings={[MISS]} />);
        expect(screen.getByTestId('output-binding-warnings').textContent).toContain('Previous step ▸ Contact ▸ Email');
    });
});
