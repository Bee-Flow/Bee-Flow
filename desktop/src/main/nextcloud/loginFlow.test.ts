import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOGIN_FLOW_USER_AGENT, pollLoginFlow, startLoginFlow, type FetchLike } from './loginFlow.ts';

function reply(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

const started = {
    poll: { token: 'poll-token-not-real', endpoint: 'https://cloud.example.com/index.php/login/v2/poll' },
    login: 'https://cloud.example.com/index.php/login/v2/flow/abcdef',
};

describe('startLoginFlow', () => {
    it('asks Nextcloud for a flow and returns where to send the browser', async () => {
        let seen: { url: string; method?: string; headers?: Record<string, string> } | null = null;
        const result = await startLoginFlow('cloud.example.com', {
            fetch: async (url, init) => {
                seen = { url, ...(init ?? {}) };
                return reply(200, started);
            },
        });

        assert.equal(seen!.url, 'https://cloud.example.com/index.php/login/v2');
        assert.equal(seen!.method, 'POST');
        assert.equal(seen!.headers?.['OCS-APIRequest'], 'true', 'without this Nextcloud answers with HTML');
        assert.equal(seen!.headers?.['User-Agent'], LOGIN_FLOW_USER_AGENT, 'so the user recognises it in Security settings');
        assert.equal(result.loginUrl, started.login);
        assert.equal(result.pollToken, 'poll-token-not-real');
    });

    it('says what a 404 means instead of repeating the status code', async () => {
        await assert.rejects(
            startLoginFlow('cloud.example.com', { fetch: async () => reply(404, {}) }),
            /did not offer the Nextcloud login flow/,
        );
    });

    it('rejects a reply that is missing a field', async () => {
        await assert.rejects(
            startLoginFlow('cloud.example.com', { fetch: async () => reply(200, { login: started.login }) }),
            /something unexpected/,
        );
    });

    it('refuses to open a login URL on another host', async () => {
        await assert.rejects(
            startLoginFlow('cloud.example.com', {
                fetch: async () => reply(200, { ...started, login: 'https://phish.example/index.php/login/v2/flow/x' }),
            }),
            /phish\.example/,
        );
    });

    it('refuses a poll endpoint on another host', async () => {
        await assert.rejects(
            startLoginFlow('cloud.example.com', {
                fetch: async () => reply(200, { ...started, poll: { token: 't', endpoint: 'https://phish.example/poll' } }),
            }),
            /not the server you asked for/,
        );
    });

    it('rejects an address it cannot use before making a request', async () => {
        let called = false;
        await assert.rejects(
            startLoginFlow('ftp://cloud.example.com', {
                fetch: async () => {
                    called = true;
                    return reply(200, started);
                },
            }),
            /not ftp/,
        );
        assert.equal(called, false);
    });
});

describe('pollLoginFlow', () => {
    const start = { loginUrl: started.login, pollEndpoint: started.poll.endpoint, pollToken: 'poll-token-not-real' };

    it('keeps waiting on a 404 and returns the credential when it arrives', async () => {
        let attempts = 0;
        const credential = await pollLoginFlow(start, {
            intervalMs: 1,
            sleep: async () => undefined,
            fetch: async (_url, init) => {
                attempts += 1;
                assert.match(String(init?.body), /token=poll-token-not-real/);
                if (attempts < 3) return reply(404, {});
                return reply(200, { server: 'https://cloud.example.com', loginName: 'tom', appPassword: 'app-password-not-real' });
            },
        });

        assert.equal(attempts, 3);
        assert.equal(credential.loginName, 'tom');
        assert.equal(credential.appPassword, 'app-password-not-real');
        assert.equal(credential.server, 'https://cloud.example.com');
    });

    it('gives up after the flow has expired', async () => {
        let clock = 0;
        await assert.rejects(
            pollLoginFlow(start, {
                intervalMs: 1,
                timeoutMs: 50,
                now: () => clock,
                sleep: async () => {
                    clock += 30;
                },
                fetch: async () => reply(404, {}),
            }),
            /not completed in time/,
        );
    });

    it('stops when the user cancels', async () => {
        const controller = new AbortController();
        await assert.rejects(
            pollLoginFlow(start, {
                intervalMs: 1,
                signal: controller.signal,
                sleep: async () => {
                    controller.abort();
                },
                fetch: async () => reply(404, {}),
            }),
            /cancelled/,
        );
    });

    it('refuses a credential minted for a different host', async () => {
        await assert.rejects(
            pollLoginFlow(start, {
                sleep: async () => undefined,
                fetch: async () => reply(200, { server: 'https://phish.example', loginName: 'tom', appPassword: 'x' }),
            }),
            /phish\.example/,
        );
    });

    it('rejects a 200 that is missing the password', async () => {
        await assert.rejects(
            pollLoginFlow(start, {
                sleep: async () => undefined,
                fetch: async () => reply(200, { server: 'https://cloud.example.com', loginName: 'tom' }),
            }),
            /did not return a usable credential/,
        );
    });

    it('surfaces a server error rather than polling forever', async () => {
        await assert.rejects(
            pollLoginFlow(start, { sleep: async () => undefined, fetch: async () => reply(500, {}) }),
            /HTTP 500/,
        );
    });
});
