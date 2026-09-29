import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: async () => ({ ok: true, json: async () => ({ token: 't', expiresAt: 0 }) }),
}));

import WebpagePreview, { PREVIEW_DEVICES } from './WebpagePreview';

/**
 * The preview toolbar (plan W2): shield · size · device · Reload · Open.
 *
 * Two of these are claims about safety and about what the user is looking at,
 * so they are pinned against the thing they describe rather than against
 * their own wording:
 *
 *   - "Running shielded" is checked against the iframe's ACTUAL sandbox
 *     attribute. A preview that gained `allow-same-origin` while still
 *     printing the shield would be the worst possible lie on this screen,
 *     and it would be invisible in a screenshot.
 *   - the size read-out is MEASURED. Where it cannot be measured (no
 *     ResizeObserver) it prints nothing, because the declared device width is
 *     only a cap and "1440 × 900" beside a 620px pane would be false.
 *
 * The third is a regression guard: switching device must not re-key the
 * iframe. WebpagePreview.postMessage.test.jsx pins that only THIS iframe's
 * contentWindow may drive the token bridge; a remount swaps that window out.
 */

function renderPreview() {
    return render(<WebpagePreview webpageId="wp1" html="<p>hi</p>" css="" js="" />);
}

describe('WebpagePreview toolbar — the shield', () => {
    it('claims shielding only because the iframe really is sandboxed', () => {
        const { container } = renderPreview();
        expect(screen.getByTestId('preview-shield')).toHaveTextContent('Running shielded');
        const sandbox = container.querySelector('iframe').getAttribute('sandbox');
        expect(sandbox).toBe('allow-scripts allow-forms');
        expect(sandbox).not.toContain('allow-same-origin');
    });
});

describe('WebpagePreview toolbar — the device toggle', () => {
    it('caps the frame at the device width and says which one is on', () => {
        const { container } = renderPreview();
        const iframe = container.querySelector('iframe');
        expect(iframe.style.maxWidth).toBe(`${PREVIEW_DEVICES.desktop.width}px`);
        expect(screen.getByTestId('preview-device-desktop')).toHaveAttribute('aria-checked', 'true');

        fireEvent.click(screen.getByTestId('preview-device-mobile'));
        expect(container.querySelector('iframe').style.maxWidth).toBe(`${PREVIEW_DEVICES.mobile.width}px`);
        expect(screen.getByTestId('preview-device-mobile')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('preview-device-desktop')).toHaveAttribute('aria-checked', 'false');
    });

    it('does NOT remount the iframe — the postMessage guard holds the same window', () => {
        const { container } = renderPreview();
        const before = container.querySelector('iframe');
        fireEvent.click(screen.getByTestId('preview-device-mobile'));
        expect(container.querySelector('iframe')).toBe(before);
    });

    it('reloading DOES remount it — that is what a reload is', () => {
        const { container } = renderPreview();
        const before = container.querySelector('iframe');
        fireEvent.click(screen.getByTitle('Reload preview'));
        expect(container.querySelector('iframe')).not.toBe(before);
    });
});

describe('WebpagePreview toolbar — the size read-out', () => {
    const originalRO = global.ResizeObserver;
    afterEach(() => { global.ResizeObserver = originalRO; });

    it('prints nothing at all when the size cannot be measured', () => {
        // jsdom lays nothing out and has no ResizeObserver — exactly the case
        // where a hardcoded "1440 × 900" would be a confident lie.
        delete global.ResizeObserver;
        renderPreview();
        expect(screen.queryByTestId('preview-size')).not.toBeInTheDocument();
    });

    it('prints the MEASURED box when it can be measured', () => {
        global.ResizeObserver = class { observe() {} disconnect() {} };
        const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockReturnValue({ width: 612.4, height: 431.7, top: 0, left: 0, right: 0, bottom: 0 });
        try {
            renderPreview();
            // 612, not 1440: the device width is a cap, and the read-out
            // reports the frame the user is actually looking at.
            expect(screen.getByTestId('preview-size')).toHaveTextContent('612 × 432');
        } finally { spy.mockRestore(); }
    });

    it('prints nothing for a zero-sized frame rather than "0 × 0"', () => {
        global.ResizeObserver = class { observe() {} disconnect() {} };
        const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockReturnValue({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
        try {
            renderPreview();
            expect(screen.queryByTestId('preview-size')).not.toBeInTheDocument();
        } finally { spy.mockRestore(); }
    });
});
