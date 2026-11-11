// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { buildAttachments, MAX_ATTACHMENT_BYTES } from './attachmentFiles';

const fileOfSize = (name: string, size: number): File => ({ name, size, type: 'text/plain' }) as unknown as File;

describe('buildAttachments size cap', () => {
    it('keeps the raw cap low enough for the base64 body to fit the 20 MB JSON limit', () => {
        expect(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4).toBeLessThan(20 * 1024 * 1024);
    });

    it('skips a file over the cap and reports it, instead of dropping it silently', async () => {
        const onTooLarge = vi.fn();
        const big = fileOfSize('rapport.pdf', MAX_ATTACHMENT_BYTES + 1);
        const result = await buildAttachments([big], onTooLarge);
        expect(result).toEqual([]);
        expect(onTooLarge).toHaveBeenCalledExactlyOnceWith(big);
    });
});
