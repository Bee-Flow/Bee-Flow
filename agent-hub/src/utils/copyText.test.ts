import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyText } from './copyText';

function setClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

describe('copyText', () => {
    let exec: ReturnType<typeof vi.fn>;
    let seen: { value: string; focused: boolean; selected: boolean; inDom: boolean } | null;

    beforeEach(() => {
        seen = null;
        exec = vi.fn(() => {
            const ta = document.querySelector('textarea');
            seen = {
                value: ta?.value ?? '',
                focused: document.activeElement === ta,
                selected: !!ta && ta.selectionEnd - ta.selectionStart === ta.value.length,
                inDom: !!ta,
            };
            return true;
        });
        Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: exec });
    });
    afterEach(() => {
        setClipboard(undefined);
        document.body.innerHTML = '';
    });

    it('uses the Clipboard API when present and never touches the DOM', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        setClipboard({ writeText });
        await expect(copyText('hello')).resolves.toBeUndefined();
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(exec).not.toHaveBeenCalled();
    });

    it('passes a Clipboard API rejection on unchanged, without the legacy copy', async () => {
        const err = new Error('denied');
        setClipboard({ writeText: vi.fn().mockRejectedValue(err) });
        await expect(copyText('x')).rejects.toBe(err);
        expect(exec).not.toHaveBeenCalled();
    });

    it('falls back to the legacy copy after a rejection when fallbackOnReject is set', async () => {
        setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
        await expect(copyText('x', { fallbackOnReject: true })).resolves.toBeUndefined();
        expect(exec).toHaveBeenCalledWith('copy');
    });

    it('uses a fixed, transparent, selected textarea that is removed again', async () => {
        setClipboard(undefined);
        let style = '';
        exec.mockImplementation(() => {
            const ta = document.querySelector('textarea')!;
            style = `${ta.style.position}|${ta.style.opacity}`;
            return true;
        });
        await copyText('secret');
        expect(style).toBe('fixed|0');
        expect(document.querySelector('textarea')).toBeNull();
    });

    it('copies the exact text through the legacy path', async () => {
        setClipboard({});
        await copyText('line1\nline2');
        expect(seen).toMatchObject({ value: 'line1\nline2', selected: true, inDom: true });
        expect(seen!.focused).toBe(false);
    });

    it('focuses the textarea only when asked to', async () => {
        await copyText('x', { focus: true });
        expect(seen!.focused).toBe(true);
    });

    it('rejects with the default message when execCommand reports failure, and still cleans up', async () => {
        exec.mockReturnValue(false);
        await expect(copyText('x')).rejects.toThrow(new Error('copy failed'));
        expect(document.querySelector('textarea')).toBeNull();
    });

    it('rejects with a custom failMessage', async () => {
        exec.mockReturnValue(false);
        await expect(copyText('x', { failMessage: 'execCommand copy returned false' }))
            .rejects.toThrow('execCommand copy returned false');
    });

    it('lets an execCommand exception through', async () => {
        const boom = new Error('boom');
        exec.mockImplementation(() => { throw boom; });
        await expect(copyText('x')).rejects.toBe(boom);
    });

    it('rejects when both paths fail with fallbackOnReject', async () => {
        setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
        exec.mockReturnValue(false);
        await expect(copyText('x', { fallbackOnReject: true })).rejects.toThrow('copy failed');
    });
});
