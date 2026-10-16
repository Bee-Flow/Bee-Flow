// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CMS_PAYLOAD_ID, ensureAppUtilities, isServerRenderedMarketingPage } from './appUtilities';

const docWith = (ids: string[]) => ({
    getElementById: (id: string) => (ids.includes(id) ? ({} as HTMLElement) : null),
});

describe('appUtilities', () => {
    it('recognises a server-rendered CMS page by its inlined payload', () => {
        expect(isServerRenderedMarketingPage(docWith([CMS_PAYLOAD_ID]))).toBe(true);
        expect(isServerRenderedMarketingPage(docWith(['root']))).toBe(false);
    });

    it('waits for the CSS before rendering anything that is not a marketing shell', async () => {
        let loaded = false;
        const load = vi.fn(async () => { loaded = true; });
        await ensureAppUtilities(docWith([]), load, vi.fn(), {});
        expect(loaded).toBe(true);
    });

    it('does not block a marketing shell: the CSS is requested after idle', async () => {
        const load = vi.fn(async () => undefined);
        let idle: (() => void) | undefined;
        await ensureAppUtilities(docWith([CMS_PAYLOAD_ID]), load, vi.fn(), {
            requestIdleCallback: (cb) => { idle = cb; return 1; },
        });
        expect(load).not.toHaveBeenCalled();
        idle?.();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('reports a failed load and still lets the app render', async () => {
        const err = new Error('offline');
        const onError = vi.fn();
        await ensureAppUtilities(docWith([]), () => Promise.reject(err), onError, {});
        expect(onError).toHaveBeenCalledWith(err);
    });
});
