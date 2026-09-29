import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 'file_gallery' thumbnails.
 *
 * The rule is not "never fetch" — it is "never REDEEM". A pending mailbox
 * attachment is a pointer at a provider and redeeming one costs a round-trip,
 * so a grid of them must stay icons. A STORED image already lives in this
 * app's own attachment store, and withholding its picture is what left a
 * werkvoorbereider staring at seven identical grey file icons, having to open
 * each one to find out which photo of the meter cupboard it was.
 */

const authFetch = vi.fn();

vi.mock('../DataContext', () => ({ useDataContext: () => ({ appId: 'app_1' }) }));
vi.mock('../../../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch: (...args) => authFetch(...args),
}));

const { default: AppFileGallery } = await import('./AppFileGallery');
const { RuntimeProvider, buildScope, DEFAULT_RUNTIME } = await import('../RuntimeContext');

function node(rows) {
    return {
        id: 'cmp_fg01',
        type: 'file_gallery',
        props: {
            source: { kind: 'static', value: rows },
            fileKey: 'bestand', titleKey: 'soort', columns: 4, rowLimit: 24,
        },
        style: {},
    };
}

function renderGallery(rows) {
    return render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), mode: 'run' }}>
            <AppFileGallery node={node(rows)} />
        </RuntimeProvider>,
    );
}

const storedImage = (id, soort) => ({
    id, soort,
    bestand: { kind: 'studio_attachment', fileId: `file_${id}`, name: `${soort}.jpg`, mime: 'image/jpeg' },
});

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:thumb');
    globalThis.URL.revokeObjectURL = vi.fn();
});

describe('stored images', () => {
    it('are fetched once each and shown as a picture', async () => {
        renderGallery([storedImage('a', 'dicht'), storedImage('b', 'open')]);
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
        // The <img> is aria-hidden — the card's title carries the meaning —
        // so assert on the DOM, not the accessibility tree.
        await waitFor(() => {
            expect(document.querySelectorAll('img[src="blob:thumb"]').length).toBe(2);
        });
        expect(authFetch.mock.calls[0][0]).toContain('/api/studio-apps/app_1/data/attachments/file_a');
    });

    it('are not refetched when the same rows render again', async () => {
        const rows = [storedImage('a', 'dicht')];
        const { rerender } = renderGallery(rows);
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
        rerender(
            <RuntimeProvider value={{ ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), mode: 'run' }}>
                <AppFileGallery node={node([...rows])} />
            </RuntimeProvider>,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    it('fall back to the type icon when the fetch fails', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 403 });
        renderGallery([storedImage('a', 'dicht')]);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(document.querySelector('img[src="blob:thumb"]')).toBeNull();
        expect(screen.getByText('dicht')).toBeTruthy();
    });
});

describe('what must never be redeemed', () => {
    it('a PENDING mailbox attachment is never fetched', async () => {
        renderGallery([{ id: 'm', soort: 'meter', bestand: { kind: 'mailbox_attachment', attachmentId: 'prov_1' } }]);
        await new Promise((r) => setTimeout(r, 20));
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('a non-image attachment is never fetched', async () => {
        renderGallery([{ id: 'p', soort: 'pdf', bestand: { kind: 'studio_attachment', fileId: 'file_p', mime: 'application/pdf' } }]);
        await new Promise((r) => setTimeout(r, 20));
        expect(authFetch).not.toHaveBeenCalled();
    });
});
