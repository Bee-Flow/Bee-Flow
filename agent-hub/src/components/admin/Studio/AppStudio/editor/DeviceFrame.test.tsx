import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import Modal from '@/components/shared/Modal';
import toast, { Toaster } from '@/components/shared/Toast';
import DeviceFrame from './DeviceFrame';

/** The frame's document once its srcdoc has loaded (jsdom may need the load event nudged). */
async function frameBody(): Promise<HTMLElement> {
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    await act(async () => {
        if (!frame.contentDocument?.body?.childElementCount) frame.dispatchEvent(new Event('load'));
        await Promise.resolve();
    });
    return frame.contentDocument!.body;
}

function Opener() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>open</button>
            <Modal open={open} onClose={() => setOpen(false)} title="Inside">
                <p>dialog body</p>
            </Modal>
        </>
    );
}

describe('DeviceFrame', () => {
    it('renders the tree inside a frame of the device width', async () => {
        render(<DeviceFrame device="phone"><p>hello app</p></DeviceFrame>);
        const frame = document.querySelector('iframe') as HTMLIFrameElement;
        expect(frame.className).toContain('w-[390px]');
        const body = await frameBody();
        expect(body.textContent).toContain('hello app');
        // Not in the editor's own document.
        expect(screen.queryByText('hello app')).toBeNull();
        expect(document.querySelector('[data-device-frame-caption]')?.textContent).toContain('390 px');
    });

    it('opens a dialog of the app inside the frame, and Escape in the frame closes it', async () => {
        render(<DeviceFrame device="tablet"><Opener /></DeviceFrame>);
        const body = await frameBody();
        const button = body.querySelector('button') as HTMLButtonElement;
        await act(async () => { button.click(); });
        expect(body.querySelector('[role="dialog"]')?.textContent).toContain('dialog body');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        await act(async () => {
            body.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(body.querySelector('[role="dialog"]')).toBeNull();
    });

    it('shows a toast raised while it is mounted inside the frame, not in the editor corner', async () => {
        render(<><Toaster /><DeviceFrame device="phone"><p>app</p></DeviceFrame></>);
        const body = await frameBody();
        await act(async () => { toast.info('saved in the app'); });
        expect(body.textContent).toContain('saved in the app');
        expect(screen.queryByText('saved in the app')).toBeNull();
        await act(async () => { toast.dismiss(); });
    });
});
