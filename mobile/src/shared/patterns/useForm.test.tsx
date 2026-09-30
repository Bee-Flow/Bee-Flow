/**
 * useForm is state a sheet trusts with a person's typing: dirty tracking,
 * when an error may show, and a submit that neither doubles nor swallows a
 * failure.
 */

import { act, renderHook } from '@testing-library/react-native';

import { useForm, validateValues, type UseFormOptions } from './useForm';
import { required } from './validators';

interface Values extends Record<string, unknown> {
    title: string;
    notes: string;
}

const INITIAL: Values = { title: 'Weekly', notes: '' };

async function setup(over: Partial<UseFormOptions<Values>> = {}) {
    const onSubmit = over.onSubmit ?? jest.fn(async () => undefined);
    const hook = await renderHook(() =>
        useForm<Values>({ initial: INITIAL, validate: { title: [required('Name it')] }, ...over, onSubmit }),
    );
    return { ...hook, onSubmit };
}

describe('useForm', () => {
    it('starts clean, valid and quiet', async () => {
        const { result } = await setup();
        expect(result.current.values).toEqual(INITIAL);
        expect(result.current.dirty).toBe(false);
        expect(result.current.valid).toBe(true);
        expect(result.current.field('title').error).toBeUndefined();
    });

    it('tracks dirty against the initial values, and back again', async () => {
        const { result } = await setup();
        await act(async () => result.current.set('title', 'Monthly'));
        expect(result.current.dirty).toBe(true);
        await act(async () => result.current.field('title').onChangeText('Weekly'));
        expect(result.current.dirty).toBe(false);
    });

    it('shows a field error only once the field was edited', async () => {
        const { result } = await setup({ initial: { title: '', notes: '' } });
        expect(result.current.errors.title).toBe('Name it');
        expect(result.current.field('title').error).toBeUndefined();
        await act(async () => result.current.set('title', '  '));
        expect(result.current.field('title').error).toBe('Name it');
        expect(result.current.canSubmit).toBe(false);
    });

    it('refuses an invalid submit and reveals every error', async () => {
        const { result, onSubmit } = await setup({ initial: { title: '', notes: '' } });
        let ok = true;
        await act(async () => {
            ok = await result.current.submit();
        });
        expect(ok).toBe(false);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(result.current.field('title').error).toBe('Name it');
    });

    it('submits the current values and reports success', async () => {
        const { result, onSubmit } = await setup();
        await act(async () => result.current.set('notes', 'n'));
        let ok = false;
        await act(async () => {
            ok = await result.current.submit();
        });
        expect(ok).toBe(true);
        expect(onSubmit).toHaveBeenCalledWith({ title: 'Weekly', notes: 'n' });
        expect(result.current.submitting).toBe(false);
    });

    it('keeps a thrown error instead of rethrowing it', async () => {
        const failure = new Error('Server said no');
        const { result } = await setup({ onSubmit: jest.fn(async () => Promise.reject(failure)) });
        await act(async () => {
            await result.current.submit();
        });
        expect(result.current.submitError).toBe(failure);
        expect(result.current.submitting).toBe(false);
    });

    it('does not submit twice for a double tap', async () => {
        let release: () => void = () => undefined;
        const onSubmit = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
        const { result } = await setup({ onSubmit });
        await act(async () => {
            const first = result.current.submit();
            const second = result.current.submit();
            expect(await second).toBe(false);
            release();
            await first;
        });
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('resets to new values, clean and untouched', async () => {
        const { result } = await setup();
        await act(async () => result.current.set('title', ''));
        await act(async () => result.current.reset({ title: 'Fresh', notes: 'x' }));
        expect(result.current.values).toEqual({ title: 'Fresh', notes: 'x' });
        expect(result.current.dirty).toBe(false);
        expect(result.current.field('title').error).toBeUndefined();
    });
});

describe('validateValues', () => {
    it('keeps the first failing message per field', () => {
        const errors = validateValues<Values>(
            { title: '', notes: '' },
            { title: [required('first'), required('second')] },
        );
        expect(errors).toEqual({ title: 'first' });
    });
});
