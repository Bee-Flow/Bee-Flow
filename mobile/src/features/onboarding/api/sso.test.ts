/**
 * Tests for the Android SSO handoff.
 *
 * Every case here is a way this flow has actually failed, not a spec check.
 * The one that matters most is the first: React Native stops dispatching JS
 * timers while the host activity is paused, and the Custom Tab is on top for
 * the whole OAuth round trip — so a poll on a timer fires ONCE, seconds before
 * the server has deposited anything, and then not again until the app is back.
 * That test drives the loop with the timers deliberately frozen, which is the
 * only way to reproduce what a phone actually does.
 *
 * The rest pin the ways the old code turned a successful sign-in into a silent
 * cancellation: a dismissed tab rejecting into a Promise.race, and a `success`
 * result resolving null straight into a `throw`.
 */

import { AppState } from 'react-native';

import { setServerUrl } from '@/core/api/server';

import { SsoCancelledError, startSsoLogin } from './sso';
import { isOAuthHandoff } from '../model/nativeIntent';

const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));

const mockOpenAuthSession = jest.fn();
jest.mock('expo-web-browser', () => ({
    openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSession(...args),
}));

jest.mock('expo-auth-session', () => ({
    makeRedirectUri: () => 'beeflow://oauth',
}));

const SERVER = 'https://beeflow.example';

/** AppState listeners registered by the module under test. */
let foregroundListeners: ((state: string) => void)[] = [];

function foreground(): void {
    for (const listener of [...foregroundListeners]) listener('active');
}

/**
 * Let every pending microtask run WITHOUT advancing the clock — which is
 * exactly the state of a React Native app whose activity is paused.
 */
async function settle(turns = 40): Promise<void> {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
    };
}

/** The pickup route answers 404 {pending:true} until the callback has run. */
const PENDING = () => jsonResponse({ pending: true }, 404);
const DEPOSITED = (token: string) => jsonResponse({ sessionToken: token });
const WHOAMI = (name: string) =>
    jsonResponse({ authenticated: true, user: { id: 'u1', displayName: name } });

/** Which endpoint a captured fetch call was for. */
function urlOf(call: unknown[]): string {
    return String(call[0]);
}
function pickupCalls(): unknown[][] {
    return mockExpoFetch.mock.calls.filter((c) => urlOf(c).includes('/auth/login-pickup'));
}

beforeEach(async () => {
    jest.useFakeTimers();
    mockExpoFetch.mockReset();
    mockOpenAuthSession.mockReset();
    foregroundListeners = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
        _type: string,
        handler: (state: string) => void,
    ) => {
        foregroundListeners.push(handler);
        return {
            remove: () => {
                foregroundListeners = foregroundListeners.filter((l) => l !== handler);
            },
        };
    }) as unknown as typeof AppState.addEventListener);
    await setServerUrl(SERVER);
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('startSsoLogin', () => {
    it('claims the token when the app returns, with the timers still frozen', async () => {
        // THE BUG. The tab is up, so no timer ever fires. The old client polled
        // once at t≈0, got nothing, and was frozen until the browser leg
        // rejected the whole flow.
        let dismiss: (r: { type: string }) => void = () => {};
        mockOpenAuthSession.mockReturnValue(new Promise((resolve) => (dismiss = resolve)));
        mockExpoFetch.mockResolvedValue(PENDING());

        const flow = startSsoLogin('google');
        await settle();

        // Exactly one attempt, and it found nothing — the server has not
        // finished the round trip yet.
        expect(pickupCalls()).toHaveLength(1);

        // The callback completes while the app is still in the background.
        mockExpoFetch.mockImplementation((url: string) =>
            Promise.resolve(
                String(url).includes('/auth/login-pickup')
                    ? DEPOSITED('tok-1')
                    : WHOAMI('Ada Lovelace'),
            ),
        );

        // The user closes the tab. NO TIMER ADVANCES — coming back is the
        // signal, and it has to be enough on its own.
        dismiss({ type: 'dismiss' });
        foreground();
        await settle();

        await expect(flow).resolves.toEqual({
            sessionToken: 'tok-1',
            // Read through the /auth/user reader, so the absent fields are its defaults.
            user: expect.objectContaining({ id: 'u1', displayName: 'Ada Lovelace' }),
        });
    });

    it('does not treat a dismissed tab as a cancellation', async () => {
        // The server's own page says "you can close this window", so closing it
        // is the user doing as they were told — not changing their mind.
        mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });
        mockExpoFetch.mockImplementation((url: string) =>
            Promise.resolve(
                String(url).includes('/auth/login-pickup') ? DEPOSITED('tok-2') : WHOAMI('Grace'),
            ),
        );

        const flow = startSsoLogin('google');
        await settle();
        await expect(flow).resolves.toMatchObject({ sessionToken: 'tok-2' });
    });

    it('does not cancel when the deep link fires and the browser reports success', async () => {
        // The old code resolved this leg with `null` and then threw on it.
        mockOpenAuthSession.mockResolvedValue({ type: 'success', url: 'beeflow://oauth' });
        mockExpoFetch.mockImplementation((url: string) =>
            Promise.resolve(
                String(url).includes('/auth/login-pickup') ? DEPOSITED('tok-3') : WHOAMI('Alan'),
            ),
        );

        const flow = startSsoLogin('google');
        await settle();
        await expect(flow).resolves.toMatchObject({ sessionToken: 'tok-3' });
    });

    it('keeps claiming across the grace window before giving up', async () => {
        mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });
        mockExpoFetch.mockResolvedValue(PENDING());

        const flow = startSsoLogin('google').catch((e) => e);
        await settle();
        const afterReturn = pickupCalls().length;

        // Well inside the grace window: still trying.
        await jest.advanceTimersByTimeAsync(2_000);
        expect(pickupCalls().length).toBeGreaterThan(afterReturn);

        // Past it: gives up rather than polling forever.
        await jest.advanceTimersByTimeAsync(15_000);
        const gaveUp = pickupCalls().length;
        await jest.advanceTimersByTimeAsync(10_000);
        expect(pickupCalls()).toHaveLength(gaveUp);

        await expect(flow).resolves.toBeInstanceOf(SsoCancelledError);
    });

    it('stays quiet when someone backs out, and speaks up when they did not', async () => {
        mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });
        mockExpoFetch.mockResolvedValue(PENDING());

        const quick = startSsoLogin('google').catch((e: SsoCancelledError) => e.reason);
        await jest.advanceTimersByTimeAsync(20_000);
        // Dismissed almost immediately: they changed their mind.
        expect(await quick).toBe('user-cancelled');

        // A `success` result means the callback definitely ran, so a missing
        // token is definitely a failure — and has to be said out loud.
        mockExpoFetch.mockClear();
        mockOpenAuthSession.mockResolvedValue({ type: 'success', url: 'beeflow://oauth' });
        const failed = startSsoLogin('google').catch((e: SsoCancelledError) => e.reason);
        await jest.advanceTimersByTimeAsync(20_000);
        expect(await failed).toBe('no-token');
    });

    it('survives one bad response from the pickup route but not two', async () => {
        mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });
        mockExpoFetch
            .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
            .mockImplementation((url: string) =>
                Promise.resolve(
                    String(url).includes('/auth/login-pickup')
                        ? DEPOSITED('tok-4')
                        : WHOAMI('Katherine'),
                ),
            );

        const survives = startSsoLogin('google');
        await jest.advanceTimersByTimeAsync(2_000);
        await expect(survives).resolves.toMatchObject({ sessionToken: 'tok-4' });

        mockExpoFetch.mockReset();
        mockExpoFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
        const dies = startSsoLogin('google').catch((e) => e);
        await jest.advanceTimersByTimeAsync(2_000);
        await expect(dies).resolves.toBeInstanceOf(Error);
    });

    it('keeps the token when the display-name lookup fails', async () => {
        // The pickup is one-shot and already spent by this point. Throwing away
        // an hour-long session because /auth/user blipped would be absurd.
        mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });
        mockExpoFetch.mockImplementation((url: string) =>
            String(url).includes('/auth/login-pickup')
                ? Promise.resolve(DEPOSITED('tok-5'))
                : Promise.reject(new Error('network')),
        );

        const flow = startSsoLogin('google');
        await jest.advanceTimersByTimeAsync(1_000);
        await expect(flow).resolves.toEqual({ sessionToken: 'tok-5', user: null });
    });

    it('asks the server for the native handoff', async () => {
        mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });
        mockExpoFetch.mockResolvedValue(PENDING());
        void startSsoLogin('google').catch(() => undefined);
        await settle();

        const authUrl = String(mockOpenAuthSession.mock.calls[0]?.[0]);
        expect(authUrl).toContain('/auth/login/google');
        expect(authUrl).toContain('popup=1');
        expect(authUrl).toMatch(/pickup=[0-9a-f]{32}/);
        // The flag that makes a deployed server redirect to beeflow://oauth so
        // the Custom Tab closes itself. An older server ignores it.
        expect(authUrl).toContain('app=beeflow');
    });
});

describe('isOAuthHandoff', () => {
    it('swallows the handoff link and nothing else', () => {
        expect(isOAuthHandoff('beeflow://oauth')).toBe(true);
        expect(isOAuthHandoff('beeflow://oauth?error=invalid_state')).toBe(true);
        expect(isOAuthHandoff('beeflow://oauth/')).toBe(true);
        // A real destination must still reach the router.
        expect(isOAuthHandoff('beeflow://chat/123')).toBe(false);
        expect(isOAuthHandoff('https://beeflow.nl/app/chat')).toBe(false);
        // Prefix matching must not swallow a sibling route.
        expect(isOAuthHandoff('beeflow://oauthsomething')).toBe(false);
    });
});
