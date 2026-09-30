/**
 * The Studio app runtime payload, read through the allow-list.
 *
 * The ways a server answer goes wrong without an error — a field renamed
 * away, a count arriving as a string, a row with no id — each has to become a
 * stated default or the shape the screen expects, never `undefined` in a prop.
 */

import { api } from '@/core/api/client';

import { getAppRuntime } from './endpoints';

jest.mock('@/core/api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;

beforeEach(() => {
    get.mockReset();
});

describe('apps', () => {
    it('passes the app definition and viewer through and defaults the rest', async () => {
        get.mockResolvedValueOnce({
            id: 'app1',
            name: 'Intake',
            definition: { screens: [{ id: 'home' }], actions: {} },
            viewer: { id: 'u1', isOwner: true },
            appVersion: null,
        });
        const runtime = await getAppRuntime('app1');
        expect(runtime).toMatchObject({
            id: 'app1',
            name: 'Intake',
            icon: null,
            definition: { screens: [{ id: 'home' }], actions: {} },
            viewer: { id: 'u1', isOwner: true },
            appVersion: null,
        });
        expect(runtime?.draft).toBeUndefined();
    });
});
