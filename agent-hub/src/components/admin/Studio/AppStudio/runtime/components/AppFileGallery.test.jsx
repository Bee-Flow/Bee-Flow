import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AppFileGallery, { formatBytes, iconForMime } from './AppFileGallery';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * 'file_gallery' — attachments as cards.
 *
 * The load-bearing assertion is a NEGATIVE one: rendering the gallery must not
 * touch the network. A mailbox attachment is a pending descriptor, and
 * redeeming one costs a provider round-trip; a grid that redeemed twelve on
 * mount would make every request screen slow and every provider quota shorter.
 */

const ROWS = [
    { id: 'att_1', filename: 'drawing.pdf', mime_type: 'application/pdf', size: 284213, file: { name: 'drawing.pdf', mimeType: 'application/pdf' } },
    { id: 'att_2', filename: 'photo.jpg', mime_type: 'image/jpeg', size: 900, file: { name: 'photo.jpg', mimeType: 'image/jpeg' } },
];

function node(rows = ROWS, extra = {}) {
    return {
        id: 'cmp_fg01', type: 'file_gallery',
        props: {
            source: { kind: 'static', value: rows },
            fileKey: 'file', titleKey: 'filename', subtitleKey: 'mime_type', sizeKey: 'size',
            columns: 3, rowLimit: 24, emptyText: 'No files yet.',
            ...extra,
        },
        style: {},
    };
}

function renderGallery(n, runtime = {}) {
    const value = {
        ...DEFAULT_RUNTIME,
        scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
        mode: 'run',
        ...runtime,
    };
    return render(
        <RuntimeProvider value={value}>
            <AppFileGallery node={n} />
        </RuntimeProvider>,
    );
}

describe('AppFileGallery', () => {
    it('renders one card per file with its type and size, and fetches nothing', () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        renderGallery(node());
        expect(screen.getByText('drawing.pdf')).toBeInTheDocument();
        expect(screen.getByText(/application\/pdf · 278 kB/)).toBeInTheDocument();
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('publishes the whole row on click so a preview can redeem it', () => {
        const runAction = vi.fn();
        renderGallery({ ...node(), onRowClick: 'act_pick01' }, { runAction });
        fireEvent.click(screen.getByText('drawing.pdf').closest('button'));
        expect(runAction).toHaveBeenCalledWith('act_pick01', { formValues: ROWS[0], item: ROWS[0] });
    });

    it('shows the empty state instead of an empty grid', () => {
        renderGallery(node([]));
        expect(screen.getByText('No files yet.')).toBeInTheDocument();
    });
});

describe('file gallery helpers', () => {
    it('formats sizes and drops nonsense ones', () => {
        expect(formatBytes(900)).toBe('900 B');
        expect(formatBytes(284213)).toBe('278 kB');
        expect(formatBytes(0)).toBeNull();
        expect(formatBytes('nope')).toBeNull();
    });

    it('picks an icon per family and falls back rather than throwing', () => {
        expect(iconForMime('image/png')).toBe(iconForMime('image/jpeg'));
        expect(iconForMime('application/pdf')).not.toBe(iconForMime('image/png'));
        expect(iconForMime(null)).toBeTruthy();
    });
});

/*
 * THE SUBTITLE LINE.
 *
 * `subtitleKey` defaults to null, which the spec means as "no subtitle" — but
 * the component read null as "fall back to the mime type". So every card in
 * every gallery carried a line nobody chose, and in a mailbox where half the
 * attachments arrive as application/octet-stream that line was both useless and
 * long enough to truncate the filename beside it — the one thing on the card
 * that tells two files apart.
 */
describe('AppFileGallery — what goes under the filename', () => {
    const STEP = [{ id: 1, filename: 'drawing.step', mime_type: 'application/octet-stream', size: 151000 }];

    it('shows the size alone when no subtitle column was chosen', () => {
        const { container } = renderGallery(node(STEP, { subtitleKey: null, columns: 1 }));
        expect(container.textContent).toContain('drawing.step');
        expect(container.textContent).toContain('147 kB');
        expect(container.textContent).not.toContain('octet-stream');
    });

    it('shows the column the author DID choose, alongside the size', () => {
        const { container } = renderGallery(node(STEP, { subtitleKey: 'mime_type', columns: 1 }));
        expect(container.textContent).toContain('application/octet-stream');
        expect(container.textContent).toContain('147 kB');
    });

    it('still picks the icon by mime type — that reading never depended on the subtitle', () => {
        const pdf = [{ id: 1, filename: 'order.pdf', mime_type: 'application/pdf', size: 10 }];
        const { container } = renderGallery(node(pdf, { subtitleKey: null }));
        expect(container.querySelector('.app-file-card-icon')).toBeTruthy();
    });
});

describe('a CAD file is a drawing, not a picture', () => {
    it('never points an <img> at a .dxf and never redeems one for a thumbnail', async () => {
        // THE BUG: image/vnd.dxf and image/vnd.dwg start with "image/", so the
        // prefix test called them images. Every mailed drawing got an <img>
        // pointed at bytes no browser can decode — a gallery of broken-picture
        // icons on the one file type people most want to see.
        const { entryIsImage } = await import('./AppInputFile');
        expect(entryIsImage({ mime: 'image/vnd.dxf', fileId: 'f1' })).toBe(false);
        expect(entryIsImage({ mime: 'image/vnd.dwg', fileId: 'f2' })).toBe(false);
        expect(entryIsImage({ mime: 'image/png', fileId: 'f3' })).toBe(true);
        expect(entryIsImage({ mime: 'image/jpeg', fileId: 'f4' })).toBe(true);
    });

    it('gives it the drafting icon rather than the photo icon', async () => {
        const { iconForMime } = await import('./AppFileGallery');
        expect(iconForMime('image/vnd.dxf')).toBe(iconForMime('model/step'));
        expect(iconForMime('image/vnd.dxf')).not.toBe(iconForMime('image/png'));
    });
});

describe('grouped by folder', () => {
    /**
     * An unpacked order archive is one folder per article beside a folder of
     * label sheets. As 243 loose cards that is a pile you scroll past — and the
     * folder is also the only thing that says which of them are parts at all.
     */
    const PACKAGE = [
        { id: '1', filename: 'PurchaseQuote.pdf', map: null, file: { name: 'PurchaseQuote.pdf', mimeType: 'application/pdf' } },
        { id: '2', filename: '3010-005424-01.dxf', map: 'RFQ/3010-005424-01', file: { name: 'a.dxf', mimeType: 'image/vnd.dxf' } },
        { id: '3', filename: '3010-005424-01.pdf', map: 'RFQ/3010-005424-01', file: { name: 'a.pdf', mimeType: 'application/pdf' } },
        { id: '4', filename: '1509-000169_6.pdf', map: 'RFQ/Labels', file: { name: 'l.pdf', mimeType: 'application/pdf' } },
    ];

    it('puts each file under its folder, with a count, loose files first', () => {
        const { container } = renderGallery(node(PACKAGE, { groupKey: 'map' }));

        const groups = [...container.querySelectorAll('[data-app-file-group]')]
            .map((el) => el.getAttribute('data-app-file-group'));
        expect(groups).toEqual(['RFQ/3010-005424-01', 'RFQ/Labels']);

        const article = container.querySelector('[data-app-file-group="RFQ/3010-005424-01"]');
        expect(article.querySelector('h4').textContent).toContain('2');
        expect(article.querySelectorAll('.app-file-card')).toHaveLength(2);

        // The mailed pdf has no folder, so it keeps its place above the groups
        // rather than being filed under an invented one.
        expect(screen.getByTitle('PurchaseQuote.pdf').closest('[data-app-file-group]')).toBe(null);
        expect(container.querySelectorAll('.app-file-card')).toHaveLength(4);
    });

    it('without groupKey it is the single flat grid it always was', () => {
        // The regression that matters: every gallery in every other app.
        const { container } = renderGallery(node(PACKAGE));
        expect(container.querySelectorAll('[data-app-file-group]')).toHaveLength(0);
        expect(container.querySelectorAll('.grid')).toHaveLength(1);
        expect(container.querySelectorAll('.app-file-card')).toHaveLength(4);
    });

    it('a column that is empty everywhere groups nothing', () => {
        const { container } = renderGallery(node(ROWS, { groupKey: 'map' }));
        expect(container.querySelectorAll('[data-app-file-group]')).toHaveLength(0);
        expect(container.querySelectorAll('.app-file-card')).toHaveLength(2);
    });
});
