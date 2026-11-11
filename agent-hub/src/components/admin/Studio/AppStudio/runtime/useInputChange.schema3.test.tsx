import { render, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import AppInputDatetime from './components/AppInputDatetime';
import { RuntimeProvider, DEFAULT_RUNTIME } from './RuntimeContext';
import { useBlurChange } from './useInputChange';

/**
 * onChange on the inputs that gained it in schema 3. A date & time field fires on every
 * change of its value, like input_date; the two text editors (input_richtext, input_html)
 * fire once when they lose focus with a value other than the one they had on focus, never
 * per keystroke. Run mode only.
 */

function runtime(runAction: (actionId: string, opts?: unknown) => void, mode: 'run' | 'edit' = 'run') {
    return ({ children }: { children: ReactNode }) => (
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode, runAction }}>{children}</RuntimeProvider>
    );
}

describe('onChange of schema 3', () => {
    it('input_datetime hands the new value to its onChange action', async () => {
        const user = userEvent.setup();
        const runAction = vi.fn();
        const Wrapper = runtime(runAction);
        const node = { id: 'cmp_d', type: 'input_datetime', props: { name: 'when', label: 'When', withTime: false }, onChange: 'act_when' };
        const { container } = render(<Wrapper><AppInputDatetime node={node as never} /></Wrapper>);
        await user.type(container.querySelector('input') as HTMLInputElement, '2026-11-10');
        expect(runAction).toHaveBeenCalled();
        const [actionId, payload] = runAction.mock.calls.at(-1) as [string, { formValues: Record<string, unknown> }];
        expect(actionId).toBe('act_when');
        expect(payload.formValues.when).toBe('2026-11-10');
    });

    it('a text editor fires once on blur, only when the value changed since focus', () => {
        const runAction = vi.fn();
        const { result } = renderHook(() => useBlurChange({ onChange: 'act_note' }, 'body'), { wrapper: runtime(runAction) });
        result.current.focus('hello');
        result.current.blur('hello');
        expect(runAction).not.toHaveBeenCalled();
        result.current.focus('hello');
        result.current.blur('hello world');
        expect(runAction).toHaveBeenCalledTimes(1);
        expect(runAction).toHaveBeenLastCalledWith('act_note', { formValues: { body: 'hello world' } });
        result.current.blur('hello world');
        expect(runAction).toHaveBeenCalledTimes(1);
    });

    it('nothing fires in edit mode', () => {
        const runAction = vi.fn();
        const { result } = renderHook(() => useBlurChange({ onChange: 'act_note' }, 'body'), { wrapper: runtime(runAction, 'edit') });
        result.current.focus('a');
        result.current.blur('b');
        expect(runAction).not.toHaveBeenCalled();
    });
});
