import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AppPdfCompare from './AppPdfCompare';
import { DataProvider } from '../DataContext';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * pdf_compare with pdf.js mocked: the engine facade hands out two fake
 * documents and the canvas diff is fed through a stubbed 2d context, so the
 * test covers loading, the change boxes, the toolbar and the failure states
 * without a real PDF.
 */

vi.mock('../../../../../../utils/helpers', () => ({
    API_BASE: 'https://api.test',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));

const engine = vi.hoisted(() => ({ openPdf: vi.fn() }));
vi.mock('./pdfCompare/pdfEngine', () => ({ openPdf: engine.openPdf, isRenderCancelled: () => false }));

const W = 1600, H = 1131;
function fakeDoc(numPages = 2) {
    return {
        numPages,
        getPage: async () => ({
            width: 842, height: 595,
            render: (canvas: HTMLCanvasElement) => { canvas.width = W; canvas.height = H; return { promise: Promise.resolve(), cancel: () => {} }; },
        }),
        destroy: vi.fn(),
    };
}

const L = { kind: 'studio_attachment', fileId: 'f1', name: 'orig.pdf', mime: 'application/pdf' };
const R = { kind: 'studio_attachment', fileId: 'f2', name: 'clean.pdf', mime: 'application/pdf' };

function mount(props: Record<string, unknown> = {}, mode = 'run') {
    const node = {
        id: 'cmp_pc', type: 'pdf_compare',
        props: { left: { kind: 'static', value: L }, right: { kind: 'static', value: R }, ...props },
        style: { span: 12, height: 'xl' },
    };
    return render(
        <DataProvider appId="app_1">
            <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode } as never}>
                <AppPdfCompare node={node as never} />
            </RuntimeProvider>
        </DataProvider>,
    );
}

beforeEach(() => {
    (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['%PDF'], { type: 'application/pdf' }) }));
    engine.openPdf.mockReset();
    engine.openPdf.mockImplementation(async () => fakeDoc());
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    // Left page white, right page white with a black block: one changed region.
    let n = 0;
    HTMLCanvasElement.prototype.getContext = vi.fn(function getContext() {
        const isRight = n++ % 2 === 1;
        const data = new Uint8ClampedArray(W * H * 4).fill(255);
        if (isRight) for (let y = 300; y < 340; y++) for (let x = 400; x < 700; x++) { const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = 0; }
        return { getImageData: () => ({ data, width: W, height: H }), drawImage: () => {} };
    }) as never;
    Element.prototype.scrollTo = vi.fn() as never;
});

describe('AppPdfCompare', () => {
    it('shows the empty text when nothing is bound', () => {
        mount({ left: { kind: 'static', value: null }, right: { kind: 'static', value: null }, emptyText: 'Nothing here' });
        expect(screen.getByText('Nothing here')).toBeTruthy();
        expect(engine.openPdf).not.toHaveBeenCalled();
    });

    it('fetches nothing while designing', () => {
        mount({}, 'design');
        expect((globalThis as unknown as { __authFetch: ReturnType<typeof vi.fn> }).__authFetch).not.toHaveBeenCalled();
        expect(engine.openPdf).not.toHaveBeenCalled();
    });

    it('loads both documents, shows both labels and the red change box', async () => {
        const { container } = mount({ leftLabel: 'Before', rightLabel: 'After' });
        await waitFor(() => expect(container.querySelector('[data-app-pdfcompare="ready"]')).toBeTruthy());
        expect(container.querySelector('[data-pdf-pane="Before"]')).toBeTruthy();
        expect(container.querySelector('[data-pdf-pane="After"]')).toBeTruthy();
        expect(screen.getByText('1 / 2')).toBeTruthy();
        await waitFor(() => expect(screen.getByText('1 change on this page')).toBeTruthy());
        // The box is drawn on BOTH panes in side mode.
        expect(container.querySelectorAll('[data-pdf-change]').length).toBe(2);
    });

    it('hides the boxes with the Show changes toggle and brings them back', async () => {
        const user = userEvent.setup();
        const { container } = mount();
        await waitFor(() => expect(screen.getByText('1 change on this page')).toBeTruthy());
        const toggle = screen.getByRole('button', { name: 'Show changes' });
        await user.click(toggle);
        expect(container.querySelectorAll('[data-pdf-change]').length).toBe(0);
        await user.click(toggle);
        expect(container.querySelectorAll('[data-pdf-change]').length).toBe(2);
    });

    it('swipe mode renders an accessible slider that responds to the keyboard', async () => {
        const user = userEvent.setup();
        mount({ mode: 'swipe' });
        const slider = await screen.findByRole('slider', { name: 'Compare slider' });
        expect(slider.getAttribute('aria-valuenow')).toBe('50');
        slider.focus();
        await user.keyboard('{ArrowRight}');
        expect(slider.getAttribute('aria-valuenow')).toBe('52');
        slider.focus();
        await user.keyboard('{End}');
        expect(slider.getAttribute('aria-valuenow')).toBe('100');
    });

    it('pages with the toolbar and clamps at the ends', async () => {
        const user = userEvent.setup();
        mount();
        await screen.findByText('1 / 2');
        const prev = screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
        expect(prev.disabled).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        expect(screen.getByText('2 / 2')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('opens the thumbnail strip with a change badge', async () => {
        const user = userEvent.setup();
        const { container } = mount();
        await waitFor(() => expect(screen.getByText('1 change on this page')).toBeTruthy());
        await user.click(screen.getByRole('button', { name: 'Page overview' }));
        await waitFor(() => expect(container.querySelector('[data-pdf-thumb-badge="1"]')).toBeTruthy());
        await user.click(screen.getByRole('button', { name: 'Page 2' }));
        expect(screen.getByText('2 / 2')).toBeTruthy();
    });

    it('with one side missing shows the other plus the empty text, and no change controls', async () => {
        mount({ right: { kind: 'static', value: null }, emptyText: 'No cleaned copy yet' });
        await screen.findByText('1 / 2');
        expect(screen.getByText('No cleaned copy yet')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Next change' })).toBeNull();
    });

    it('degrades to a placeholder when the PDF engine is unavailable', async () => {
        engine.openPdf.mockRejectedValue(new Error('no worker'));
        const { container } = mount();
        await waitFor(() => expect(container.querySelector('[data-app-pdfcompare="unavailable"]')).toBeTruthy());
        expect(screen.getByText('The PDF preview is not available here.')).toBeTruthy();
    });

    it('shows the server error with a retry when a file cannot be fetched', async () => {
        (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async () => ({ ok: false, status: 403, blob: async () => new Blob([]) }));
        mount();
        expect(await screen.findByText('You do not have access to this file.')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
    });

    it('offers a download for each side unless disabled', async () => {
        const first = mount();
        await screen.findByText('1 / 2');
        expect(first.container.querySelectorAll('a[download]').length).toBe(2);
        first.unmount();
        const second = mount({ allowDownload: false });
        await screen.findByText('1 / 2');
        expect(second.container.querySelectorAll('a[download]').length).toBe(0);
    });
});
