/**
 * An owner's app opened on its draft (Studio's `?draft=1`) runs the draft's
 * actions too. The server resolves an action from the PUBLISHED definition
 * unless the owner sends `?draft=1` with the run (routes/studioAppsRun.js), so
 * a button drawn from the draft but run without it answered 404 on an
 * unpublished app, or ran the published action with the draft form's values.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AppDetailScreen } from './AppDetailScreen';

jest.setTimeout(30_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

function runtime(draft: boolean) {
    return {
        id: 'app1',
        name: 'Leads',
        icon: null,
        accentColor: null,
        appVersion: draft ? null : 3,
        draft,
        viewer: { isOwner: draft },
        definition: {
            homeScreenId: 's1',
            screens: [
                {
                    id: 's1',
                    name: 'Home',
                    sections: [{ id: 'sec1', children: [{ id: 'b1', type: 'button', props: { label: 'Go' }, onClick: 'go' }] }],
                },
            ],
            actions: { go: { kind: 'run_automation', automationId: 'au1' } },
        },
    };
}

async function pressGo(draft: boolean) {
    get.mockResolvedValue(runtime(draft));
    await renderWithProviders(<AppDetailScreen id="app1" draft={draft} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Go' }));
    return post.mock.calls.at(-1) as [string, unknown, { query?: Record<string, string> }];
}

beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ runId: 'r1', status: 'success', output: 'ok' });
});

afterEach(async () => {
    await cleanup();
});

describe('AppDetailScreen', () => {
    it('runs a button of the draft it shows against that draft', async () => {
        const [url, body, options] = await pressGo(true);
        expect(url).toBe('/api/studio-apps/app1/actions/go/run');
        expect(body).toEqual({ formValues: {} });
        expect(options.query).toEqual({ draft: '1' });
    });

    it('runs the published app as published', async () => {
        const [, , options] = await pressGo(false);
        expect(options.query).toBeUndefined();
    });
});
