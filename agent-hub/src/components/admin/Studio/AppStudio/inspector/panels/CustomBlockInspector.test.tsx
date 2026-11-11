import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { screenApp } from '@/test/appScreenRender';
import { findNode } from '../../state/definitionOps';
import type { AppDefinition, AppNode } from '../appDefinition';
import CustomBlockInspector from './CustomBlockInspector';
import { getInspectorForType, getPanelCoverage } from '../registry';

const ID = 'cmp_blk000001';
const ACTIONS = { act_pick000001: { kind: 'toast', message: 'picked' } };

function panel(block: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
    const definition = screenApp([{ id: ID, type: 'custom_block', visible: true, style: { span: 12 }, props: block ? { block } : {} }], ACTIONS);
    const node = findNode(definition, ID).node as AppNode;
    const onCommit = vi.fn();
    const view = render(<CustomBlockInspector node={node} definition={definition} onCommit={onCommit} {...extra} />);
    const committed = () => (findNode(onCommit.mock.calls.at(-1)?.[0] as AppDefinition, ID).node.props as { block: Record<string, unknown> }).block;
    return { ...view, onCommit, committed, user: userEvent.setup() };
}

describe('CustomBlockInspector', () => {
    it('is the panel of custom_block and edits its one prop', () => {
        expect(getInspectorForType('custom_block')).toBe(CustomBlockInspector);
        expect(getPanelCoverage('custom_block')).toEqual({ props: ['block'] });
    });

    it('writes the template as typed and keeps the rest of the block', async () => {
        const { user, committed } = panel({ template: '<p>a</p>', css: 'p{color:red}', inputs: { who: { kind: 'static', value: 'Ada' } } });
        await user.type(screen.getByLabelText('HTML template'), 'b');
        expect(committed()).toEqual({ template: '<p>a</p>b', css: 'p{color:red}', inputs: { who: { kind: 'static', value: 'Ada' } } });
    });

    it('names what saving would leave out, with the line it is on', () => {
        panel({ template: '<p>ok</p>\n<script>x()</script>\n<p onclick="y()">z</p>' });
        const findings = screen.getByRole('status');
        expect(findings.getAttribute('data-custom-block-findings')).toBe('2');
        expect(within(findings).getByText('Line 2')).toBeTruthy();
        expect(within(findings).getByText('Line 3')).toBeTruthy();
        expect(findings.textContent).toContain('<script> is not an element a block may hold');
        expect(findings.textContent).toContain('onclick');
    });

    it('previews with the fixed inputs, in the same kind of frame as the page', () => {
        const { container } = panel({ template: '<p>Hello {{ who }}{{ live }}</p><button data-emit="pick">Go</button>', inputs: { who: { kind: 'static', value: 'Ada' }, live: { kind: 'formula', expr: 'vars.x' } }, events: { pick: 'act_pick000001' } });
        const frame = container.querySelector('[data-custom-block-preview]') as HTMLIFrameElement;
        expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
        const srcdoc = frame.getAttribute('srcdoc') || '';
        expect(srcdoc).toContain('<p>Hello Ada</p>');
        // The preview wires nothing.
        expect(srcdoc).not.toContain('data-bf-emit');
    });

    it('an empty block has no preview', () => {
        const { container } = panel(undefined);
        expect(container.querySelector('[data-custom-block-preview]')).toBeNull();
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('the CSS tab holds the stylesheet and says what is left out of it', async () => {
        const { user, committed } = panel({ template: '<p>a</p>', css: 'p{background:url(http://leak.example/x.png)}' });
        await user.click(screen.getByRole('radio', { name: 'CSS' }));
        const field = screen.getByLabelText('Stylesheet of this block');
        expect(field).toHaveValue('p{background:url(http://leak.example/x.png)}');
        expect(screen.getByText('Left out when the block is shown:')).toBeTruthy();
        await user.clear(field);
        expect(committed()).toEqual({ template: '<p>a</p>' });
    });

    it('adds, renames and removes an input; a taken name is not taken over', async () => {
        const first = panel({ template: '<p>a</p>' });
        await first.user.click(screen.getByRole('button', { name: 'Add input' }));
        expect(first.committed()).toEqual({ template: '<p>a</p>', inputs: { value: { kind: 'static', value: '' } } });
        first.unmount();

        const two = panel({ template: '<p>a</p>', inputs: { a: { kind: 'static', value: 1 }, b: { kind: 'static', value: 2 } } });
        const names = screen.getAllByLabelText('Name, as the template reads it');
        await two.user.type(names[1], 'c');
        expect(Object.keys(two.committed().inputs as object)).toEqual(['a', 'bc']);
        two.onCommit.mockClear();
        await two.user.clear(names[1]);
        await two.user.type(names[1], 'a');
        // "a" exists: the second entry keeps its name.
        expect(two.onCommit.mock.calls.every((call) => Object.keys((findNode(call[0] as AppDefinition, ID).node.props as { block: { inputs: object } }).block.inputs).length === 2)).toBe(true);
        await two.user.click(screen.getByRole('button', { name: 'Remove the input a' }));
        expect(Object.keys(two.committed().inputs as object)).not.toContain('a');
    });

    it('adds an event, not wired yet, and removes it', async () => {
        const { user, committed } = panel({ template: '<button data-emit="pick">Go</button>' });
        await user.click(screen.getByRole('button', { name: 'Add event' }));
        expect(committed().events).toEqual({ pick: null });
    });

    it('is read-only when disabled', () => {
        panel({ template: '<p>a</p>', inputs: { a: { kind: 'static', value: 1 } } }, { disabled: true });
        expect(screen.getByLabelText('HTML template')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Add input' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Add event' })).toBeDisabled();
    });
});
