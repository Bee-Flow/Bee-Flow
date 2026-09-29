import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drawing in a table cell.
 *
 * THE BUG THIS EXISTS FOR: which file types the server can draw is answered in
 * four places — the /preview route, AppFilePreview, the gallery icon map, and
 * this thumbnail. DXF was taught to the first three and not the fourth, so an
 * order of twenty mailed cut files showed a column of twenty em-dashes in the
 * one view where you most want to see WHICH plate a row is. A list that decides
 * what is drawable needs a test that names every member.
 */

const authFetch = vi.fn();

vi.mock('../DataContext', () => ({ useDataContext: () => ({ appId: 'app_1' }) }));
vi.mock('../../../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch: (...args) => authFetch(...args),
}));

const { default: CadThumb } = await import('./CadThumb');

const file = (name, mime) => ({ kind: 'studio_attachment', fileId: 'f_1', name, mime });

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:sheet');
    globalThis.URL.revokeObjectURL = vi.fn();
});

describe('what the cell will draw', () => {
    it.each([
        ['a 3D model', file('MW2604-01-3021-001.step', 'model/step'), '/preview'],
        ['a cut file', file('19.0592.136.01_alu_5mm.DXF', 'image/vnd.dxf'), '/preview'],
        ['a cut file the mailer mislabelled', file('plaat.dxf', 'application/octet-stream'), '/preview'],
        ['a cut file with only its mime to go on', file('download', 'image/vnd.dxf'), '/preview'],
    ])('%s is rendered from a sheet the server draws', async (_what, descriptor, suffix) => {
        render(<CadThumb value={descriptor} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(authFetch.mock.calls[0][0]).toContain(suffix);
        await waitFor(() => expect(screen.getByRole('button')).toBeTruthy());
    });

    it('shows a PDF as itself — no server render in between', async () => {
        render(<CadThumb value={file('MW2604-01-3021-001.pdf', 'application/pdf')} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(authFetch.mock.calls[0][0]).not.toContain('/preview');
    });

    it('stays a quiet dash for a file nothing here can draw', () => {
        // A DWG has no renderer on either side. Promising a preview and then
        // failing is worse than saying nothing: the cell would spin, fetch, and
        // land on an icon anyway.
        const { container } = render(<CadThumb value={file('plaat.dwg', 'image/vnd.dwg')} />);
        expect(container.textContent).toBe('—');
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('stays a dash for an empty cell', () => {
        const { container } = render(<CadThumb value={null} />);
        expect(container.textContent).toBe('—');
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('accepts the descriptor as JSON text, which is how a file column reads back', async () => {
        render(<CadThumb value={JSON.stringify(file('plaat_20mm.DXF', 'image/vnd.dxf'))} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(authFetch.mock.calls[0][0]).toContain('/preview');
    });
});

/**
 * A `file` column is JSON TEXT on the read path, and rows written while a
 * connector pre-stringified its descriptors are DOUBLE-encoded: the text starts
 * with a quote, and the first parse hands back another string. The server's
 * normalizeFileDescriptors already unwraps repeatedly for exactly this reason;
 * this side used to bail on the first character and drew an em dash over a
 * drawing that was plainly there.
 */
describe('descriptors that arrive as text', () => {
    const descriptor = { kind: 'studio_attachment', fileId: 'f_1', name: 'TN2506-01-3166-001.pdf', mime: 'application/pdf' };

    it.each([
        ['once', JSON.stringify(descriptor)],
        ['twice', JSON.stringify(JSON.stringify(descriptor))],
    ])('unwraps a descriptor encoded %s', async (_how, value) => {
        render(<CadThumb value={value} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(authFetch.mock.calls[0][0]).toContain('f_1');
    });

    it('still draws nothing for text that is not a descriptor', () => {
        const { container } = render(<CadThumb value="TN2506-01-3166-001.pdf" />);
        expect(authFetch).not.toHaveBeenCalled();
        expect(container.querySelector('button')).toBeNull();
    });
});
