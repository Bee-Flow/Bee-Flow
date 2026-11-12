import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppFilePreview from './AppFilePreview';
import { DataProvider } from '../DataContext';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';

// The frame shows a PDF only as a PDF: the blob it gets is typed application/pdf,
// whatever type the stored file was served with. The file comes from a stubbed global fetch.

const STUDIO = { kind: 'studio_attachment', fileId: 'f1', name: 'invoice.pdf', mime: 'application/pdf', size: 10 };
const made: Blob[] = [];

beforeEach(() => {
    made.length = 0;
    URL.createObjectURL = vi.fn((b: Blob) => { made.push(b); return `blob:mock-${made.length}`; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
});
const realFetch = globalThis.fetch;
afterEach(() => { vi.restoreAllMocks(); globalThis.fetch = realFetch; });

function show(servedType: string) {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), blob: async () => new Blob(['<script>x</script>'], { type: servedType }) })) as unknown as typeof fetch;
    const node = { id: 'cmp_fp', type: 'file_preview', props: { source: { kind: 'static', value: STUDIO }, viewer: 'browser', allowDownload: true }, style: { span: 12, height: 'lg' } };
    return render(
        <DataProvider appId="app_1">
            <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run' }}>
                <AppFilePreview node={node as never} />
            </RuntimeProvider>
        </DataProvider>,
    );
}

describe('AppFilePreview framing a PDF', () => {
    it('retypes a blob served as text/html to application/pdf before it is framed', async () => {
        const { container } = show('text/html');
        await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
        expect(made[0].type).toBe('application/pdf');
        expect(container.querySelector('iframe')!.getAttribute('src')).toBe('blob:mock-1');
    });

    it('keeps a blob that already is a PDF', async () => {
        const { container } = show('application/pdf');
        await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
        expect(made[0].type).toBe('application/pdf');
    });
});
