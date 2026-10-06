/**
 * A path field stores what its example line previews — the trimmed path — and
 * a pick lands in the canonical spelling the run resolves.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import PathFieldJs from './PathField';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { editor, typeInEditor } from '../../../../test/refEditor';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const PathField = PathFieldJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

const ROOT = { steps: { graph: { output: { value: [1, 2], 'line-items': [{ sku: 'A' }] } } } };

type Handle = { insert: (path: string) => void };

function setup(value = '') {
    const onChange = vi.fn();
    let handle: Handle | null = null;
    render(
        <VariablePickerProvider groups={[]} previewSample={ROOT} stepLabelById={new Map()} stepTypeById={null}>
            <PathField label="Loop over" value={value} onChange={onChange} expectArray onFocusField={(h: Handle) => { handle = h; }} />
        </VariablePickerProvider>,
    );
    return { onChange, handle: () => handle as unknown as Handle };
}

afterEach(() => cleanup());

describe('PathField', () => {
    it.each(['steps.graph.output.value ', 'steps.graph.output.value\n'])('stores %j trimmed, as previewed', (typed) => {
        const { onChange } = setup();
        typeInEditor(editor(document.body) as HTMLElement, typed);
        const stored = onChange.mock.lastCall?.[0];
        expect(stored).toBe('steps.graph.output.value');
        expect(getPath(ROOT, stored)).toEqual([1, 2]);
        expect(screen.getByText('[2 items]')).toBeTruthy();
    });

    it('a pick with a dashed key is stored canonically', () => {
        const { onChange, handle } = setup();
        act(() => { editor(document.body)?.focus(); });
        act(() => handle().insert('steps.graph.output.line-items'));
        expect(onChange.mock.lastCall?.[0]).toBe('steps.graph.output["line-items"]');
    });
});
