import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AvatarPicker from './AvatarPicker';
import { toast } from '@/components/shared/Toast';
import type { resizeImageForUpload } from '@/utils/imageResize';

// jsdom has no canvas: the resize is handed in through the `resize` prop, and
// its result is the input here.
const resize = vi.fn<typeof resizeImageForUpload>();
const t = (_key: string | undefined, fallback?: unknown) => (typeof fallback === 'string' ? fallback : '');

function result(resizedSize: number) {
    return {
        blob: new Blob(), dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png',
        width: 256, height: 256, originalSize: 1_300_000, resizedSize, resized: true,
    };
}

async function upload(file: File) {
    const onChange = vi.fn();
    const ui = userEvent.setup();
    const { container } = render(<AvatarPicker avatar="🤖" onChange={onChange} t={t} size="hero" resize={resize} />);
    await ui.click(screen.getByRole('button'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await ui.upload(input, file);
    return onChange;
}

describe('AvatarPicker upload', () => {
    beforeEach(() => { resize.mockReset(); });

    it('scales a large image down to avatar size instead of refusing it', async () => {
        resize.mockResolvedValue(result(40_000));
        const big = new File([new Uint8Array(1_300_000)], 'robot.png', { type: 'image/png' });
        const onChange = await upload(big);
        expect(resize).toHaveBeenCalledWith(big, { maxLongestEdge: 256, skipIfBytesUnder: 0 });
        expect(onChange).toHaveBeenCalledWith('data:image/png;base64,AAAA');
    });

    it('refuses only what is still over 512 KB after scaling', async () => {
        const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        resize.mockResolvedValue(result(600 * 1024));
        const onChange = await upload(new File([new Uint8Array(10)], 'anim.gif', { type: 'image/gif' }));
        expect(onChange).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('Image must be under 512KB');
    });
});
