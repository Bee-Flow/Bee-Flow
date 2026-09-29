import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({
    authFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('../../../../../../utils/helpers', () => ({ API_BASE: 'https://api.test', authFetch }));
// All the component reads from the data context is which app it sits in.
vi.mock('../DataContext', () => ({ useDataContext: () => ({ appId: 'app_1' }) }));

import AppDatasetUpload from './AppDatasetUpload';
import { DEFAULT_RUNTIME, RuntimeProvider, buildScope } from '../RuntimeContext';

/**
 * 'input_dataset' — pick a ready genome file, or upload one and wait for it.
 *
 * Its list and its status poll read the large-dataset router
 * (routes/studioAppDatasets.js) on /api/studio-apps/:id/large-datasets. On
 * /:id/datasets they got the BI saved datasets back instead: none of those has
 * a status, so the picker never offered a single file.
 */

const BASE = 'https://api.test/api/studio-apps/app_1/large-datasets';
const NEW_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

/** The large-dataset router, as far as this component talks to it. */
function largeDatasetServer(url: string, init?: RequestInit) {
    const method = init?.method || 'GET';
    if (method === 'GET' && url === BASE) {
        return json({
            datasets: [
                { id: 'ds_ready', name: 'me.vcf', status: 'ready', build: 'GRCh38', variantCount: 12 },
                { id: 'ds_busy', name: 'half.vcf', status: 'ingesting', build: null, variantCount: null },
            ],
        });
    }
    if (method === 'POST' && url === BASE) return json({ datasetId: NEW_ID, partSize: 1024, partsTotal: 1 });
    if (method === 'PUT' && url === `${BASE}/${NEW_ID}/parts/0`) return json({ ok: true, partsDone: 1 });
    if (method === 'POST' && url === `${BASE}/${NEW_ID}/complete`) return json({ ok: true, status: 'uploaded' });
    if (method === 'GET' && url === `${BASE}/${NEW_ID}`) {
        return json({ id: NEW_ID, name: 'new.vcf', status: 'ready', build: 'GRCh38' });
    }
    return json({ error: `no route: ${method} ${url}` }, 404);
}

const NODE = {
    id: 'cmp_ds01', type: 'input_dataset', onChange: 'act_use',
    props: { name: 'genome', label: 'Genome file' },
    style: {},
};

function renderInput(runAction = vi.fn()) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), mode: 'run', runAction };
    const view = render(
        <RuntimeProvider value={value}>
            <AppDatasetUpload node={NODE} />
        </RuntimeProvider>,
    );
    return { ...view, runAction };
}

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockImplementation(async (url, init) => largeDatasetServer(url, init));
});

describe('AppDatasetUpload', () => {
    it('offers the ready large datasets, read from /large-datasets', async () => {
        renderInput();
        const picker = await screen.findByRole('combobox', { name: /pick an existing dataset/ });
        const options = within(picker).getAllByRole('option').map((o) => o.textContent);
        expect(options).toEqual(['Pick a dataset…', 'me.vcf (GRCh38) — 12 variants']);
        expect(authFetch.mock.calls[0][0]).toBe(BASE);
    });

    it('uploads a file, polls it at /large-datasets/<id> and hands on its descriptor once ready', async () => {
        const user = userEvent.setup();
        const { container, runAction } = renderInput();
        await screen.findByRole('combobox', { name: /pick an existing dataset/ });

        const input = container.querySelector<HTMLInputElement>('input[type="file"]');
        if (!input) throw new Error('no file input');
        await user.upload(input, new File(['##fileformat=VCFv4.2\n'], 'new.vcf', { type: 'text/plain' }));

        expect(await screen.findByText('new.vcf · GRCh38')).toBeInTheDocument();
        const descriptor = { kind: 'studio_dataset', datasetId: NEW_ID, name: 'new.vcf', build: 'GRCh38' };
        await waitFor(() => expect(runAction).toHaveBeenCalledWith('act_use', { formValues: { genome: descriptor } }));
        const seen = authFetch.mock.calls.map(([url, init]) => `${init?.method || 'GET'} ${url}`);
        expect(seen).toContain(`GET ${BASE}/${NEW_ID}`);
        expect(seen.filter((call) => !call.includes('/large-datasets'))).toEqual([]);
    });
});
