// "Add from a file": a package file is read, the server checks it and says who signed it, and only then can it be
// added. A file that is no package is said to be one. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import CoworkPackageImport from './CoworkPackageImport';

afterEach(() => { vi.unstubAllGlobals(); });

const PREVIEW = { title: 'Supplier radar', brief: 'Watch the suppliers.', repeatInterval: 'weekly', plan: null, signedBy: { keyId: 'abcd1234', thisInstallation: false } };
const file = (text: string) => new File([text], 'cowork.json', { type: 'application/json' });

describe('CoworkPackageImport', () => {
    it('shows who signed it before anything is added, then adds it and opens the new item', async () => {
        const calls = stubRecordingFetch(({ url }) => jsonResponse(url.endsWith('/preview') ? PREVIEW : { item: { id: 'w9' }, planAttached: false, findings: [] }));
        const onAdded = vi.fn();
        renderWithClient(<CoworkPackageImport onAdded={onAdded} />);
        const user = userEvent.setup();
        await user.upload(screen.getByLabelText('Add from a file'), file(JSON.stringify({ format: 'beeflow.cowork-package', v: 1 })));
        expect(await screen.findByText(/Signed by another Bee Flow \(key abcd1234\)/)).toBeInTheDocument();
        expect(calls.filter((c) => c.url.endsWith('/add'))).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Add to my cowork' }));
        await waitFor(() => expect(onAdded).toHaveBeenCalledWith('w9'));
        expect(calls.find((c) => c.url.endsWith('/add'))?.body).toEqual({ package: { format: 'beeflow.cowork-package', v: 1 } });
    });

    it('a file that is not JSON is no package, and nothing is asked', async () => {
        const calls = stubRecordingFetch(() => jsonResponse(PREVIEW));
        renderWithClient(<CoworkPackageImport onAdded={vi.fn()} />);
        await userEvent.setup().upload(screen.getByLabelText('Add from a file'), file('not json'));
        expect(await screen.findByRole('alert')).toHaveTextContent('That file is not a Cowork package.');
        expect(calls).toHaveLength(0);
    });
});
