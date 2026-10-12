/**
 * A request that fails while the phone has no network is an OfflineError,
 * not "Something went wrong".
 *
 * The distinction is the whole point of the class: OfflineError existed,
 * describeError rendered it as "You are offline", and nothing ever threw it —
 * so a person in a lift read "The connection to the server was lost" and went
 * looking for a server problem. The rules: a transport failure while NetInfo
 * says offline is the device being offline; a server answer of any status is
 * not; and being offline is not retried, because the backoff cannot change it.
 */

import { api, ApiError, OfflineError, setConnectivity, setUnauthorizedHandler } from './client';
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

/**
 * Retrying is only safe when sending the request twice is harmless. A 503 or a
 * timeout does not say whether the first attempt landed, so a retried POST can
 * create a second skill or toggle an automation straight back off. Reads keep the
 * backoff that saves a cold start on a radio that has not associated yet.
 */
describe('retries', () => {
    const fast = { attempts: 2, base: 1 };

    it('retries a GET that answered 503', async () => {
        mockExpoFetch
            .mockImplementationOnce(() => serverAnswer(503, { error: 'Service unavailable' }))
            .mockImplementationOnce(() => serverAnswer(200, { ok: true }));

        expect(await api.get('/api/things', { retry: { base: 1 } })).toEqual({ ok: true });
        expect(mockExpoFetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a POST that answered 503, unless asked to', async () => {
        mockExpoFetch.mockImplementation(() => serverAnswer(503, { error: 'Service unavailable' }));

        const failure = await api.post('/api/skills', { name: 'x' }).catch((err: unknown) => err);
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(503);
        expect(mockExpoFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry PUT, PATCH or DELETE by default either', async () => {
        mockExpoFetch.mockImplementation(() => serverAnswer(503, {}));

        await api.put('/api/things/1', {}).catch(() => null);
        await api.patch('/api/things/1', {}).catch(() => null);
        await api.delete('/api/things/1').catch(() => null);
        expect(mockExpoFetch).toHaveBeenCalledTimes(3);
    });

    it('retries a write whose refusal proves the handler never ran', async () => {
        // requireCapability answers this from middleware, before the route:
        // the skill was not created, and the server asks us to come back.
        mockExpoFetch
            .mockImplementationOnce(() => serverAnswer(503, { error: 'entitlement_unavailable', retry_after: 1 }))
            .mockImplementationOnce(() => serverAnswer(200, { id: 's1' }));

        expect(await api.post('/api/skills', { name: 'x' })).toEqual({ id: 's1' });
        expect(mockExpoFetch).toHaveBeenCalledTimes(2);
    });

    it('retries a write the rate limiter turned away', async () => {
        mockExpoFetch
            .mockImplementationOnce(() => serverAnswer(429, { error: 'Too many requests' }))
            .mockImplementationOnce(() => serverAnswer(200, { ok: true }));

        expect(await api.patch('/api/things/1', { on: true })).toEqual({ ok: true });
        expect(mockExpoFetch).toHaveBeenCalledTimes(2);
    });

    it('retries a POST whose caller opted in', async () => {
        mockExpoFetch
            .mockImplementationOnce(() => serverAnswer(503, {}))
            .mockImplementationOnce(() => serverAnswer(200, { ok: true }));

        expect(await api.post('/api/search', { q: 'x' }, { retry: fast })).toEqual({ ok: true });
        expect(mockExpoFetch).toHaveBeenCalledTimes(2);
    });

    it('still honours retry: false on a GET', async () => {
        mockExpoFetch.mockImplementation(() => serverAnswer(503, {}));

        await api.get('/api/things', { retry: false }).catch(() => null);
        expect(mockExpoFetch).toHaveBeenCalledTimes(1);
    });
});

/**
 * Two body shapes carry a refusal: the HttpError one, `{ error: '<sentence>',
 * code }`, and `{ error: '<code>', message: '<sentence>' }`, which
 * requireTraining and the voice route send. Reading `error` first showed the
 * second shape to a person as "training_required".
 */
describe('the error message', () => {
    async function failureFor(status: number, body: unknown): Promise<ApiError> {
        mockExpoFetch.mockImplementation(() => serverAnswer(status, body));
        return (await api.get('/api/things', { retry: false }).catch((err: unknown) => err)) as ApiError;
    }

    it('is the human message when error is a snake_case code', async () => {
        const failure = await failureFor(403, {
            error: 'training_required',
            message: 'Finish the course "Agents 101" before using this.',
            training: { area: 'agents' },
        });
        expect(failure.message).toBe('Finish the course "Agents 101" before using this.');
        expect(failure.code).toBe('training_required');
    });

    it('is still error when error is a sentence', async () => {
        const failure = await failureFor(403, {
            error: 'You cannot edit this skill',
            code: 'not_editable',
        });
        expect(failure.message).toBe('You cannot edit this skill');
        expect(failure.code).toBe('not_editable');
    });

    it('keeps a bare code rather than a status when that is all there is', async () => {
        const failure = await failureFor(409, { error: 'in_use' });
        expect(failure.message).toBe('in_use');
        expect(failure.code).toBe('in_use');
    });

    it('falls back to the status for a body with neither', async () => {
        const failure = await failureFor(500, null);
        expect(failure.message).toBe('HTTP 500');
        expect(failure.code).toBeUndefined();
    });
});

describe('a 401', () => {
    afterEach(() => setUnauthorizedHandler(null));

    it('tells the auth layer, except on paths where it is the expected answer', async () => {
        const handler = jest.fn();
        setUnauthorizedHandler(handler);
        mockExpoFetch.mockImplementation(() => serverAnswer(401, { error: 'Not authenticated' }));

        await api.get('/api/things').catch(() => null);
        await api.get('/auth/user').catch(() => null);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith('/api/things');
    });
});
