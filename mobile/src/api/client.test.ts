/**
 * A request that fails while the phone has no network is an OfflineError,
 * not "Something went wrong".
 *
 * The distinction is the whole point of the class: OfflineError existed,
 * Feedback.tsx rendered it as "You are offline", and nothing ever threw it —
 * so a person in a lift read "The connection to the server was lost" and went
 * looking for a server problem. The rules: a transport failure while NetInfo
 * says offline is the device being offline; a server answer of any status is
 * not; and being offline is not retried, because the backoff cannot change it.
 */

import { api, ApiError, OfflineError, setConnectivity } from './client';
import { setServerUrl } from './server';

const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));

function networkFailure() {
    return Promise.reject(new TypeError('Network request failed'));
}

function serverAnswer(status: number, body: unknown) {
    return Promise.resolve({
        ok: status < 400,
        status,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => body,
        text: async () => JSON.stringify(body),
    });
}

beforeAll(async () => {
    await setServerUrl('https://bee.example');
});

beforeEach(() => {
    mockExpoFetch.mockReset();
    setConnectivity(null);
});

describe('a transport failure', () => {
    it('is an OfflineError while the platform reports no network', async () => {
        setConnectivity(false);
        mockExpoFetch.mockImplementation(networkFailure);

        await expect(api.get('/api/things')).rejects.toBeInstanceOf(OfflineError);
    });

    it('is not retried while offline — the backoff cannot bring the network back', async () => {
        setConnectivity(false);
        mockExpoFetch.mockImplementation(networkFailure);

        await expect(api.get('/api/things', { retry: { attempts: 3, base: 1 } })).rejects.toBeInstanceOf(
            OfflineError,
        );
        expect(mockExpoFetch).toHaveBeenCalledTimes(1);
    });

    it('stays the raw error while the network is up, or unknown', async () => {
        mockExpoFetch.mockImplementation(networkFailure);
        await expect(api.get('/api/things', { retry: false })).rejects.toThrow('Network request failed');

        setConnectivity(true);
        await expect(api.get('/api/things', { retry: false })).rejects.toThrow('Network request failed');
    });
});

describe('a server answer', () => {
    it('is never an OfflineError, whatever NetInfo says', async () => {
        setConnectivity(false);
        mockExpoFetch.mockImplementation(() => serverAnswer(404, { error: 'No such thing' }));

        const failure = await api.get('/api/things').catch((err: unknown) => err);
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(404);
    });

    it('still reads normally once the network is back', async () => {
        setConnectivity(true);
        mockExpoFetch.mockImplementation(() => serverAnswer(200, { ok: true }));

        expect(await api.get('/api/things')).toEqual({ ok: true });
    });
});
