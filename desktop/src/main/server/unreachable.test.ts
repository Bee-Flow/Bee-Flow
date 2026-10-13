import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { failedLoadVerdict, redirectVerdict } from './unreachable.ts';

describe('failedLoadVerdict', () => {
    it('retries once, quietly, when the server answers the probe', () => {
        assert.deepEqual(failedLoadVerdict({ ok: true, url: 'https://bee.example.com' }, false, 'ERR_CONNECTION_RESET'), { kind: 'retry' });
    });

    it('explains after the one retry is spent, even with a good probe', () => {
        assert.deepEqual(failedLoadVerdict({ ok: true, url: 'https://bee.example.com' }, true, 'ERR_CONNECTION_RESET'), {
            kind: 'explain',
            error: 'ERR_CONNECTION_RESET',
            code: 'unknown',
            redirectTarget: undefined,
        });
    });

    it('prefers the probe’s words and code over Chromium’s', () => {
        const probe = { ok: false, url: 'https://bee.example.com', error: 'The certificate has expired.', code: 'tls' as const };
        assert.deepEqual(failedLoadVerdict(probe, false, 'ERR_CERT_DATE_INVALID'), {
            kind: 'explain',
            error: 'The certificate has expired.',
            code: 'tls',
            redirectTarget: undefined,
        });
    });

    it('passes a redirect target on to the page', () => {
        const probe = { ok: false, url: 'https://bee.example.com', error: 'It moved.', code: 'http-error' as const, redirectTarget: 'https://new.example.com' };
        assert.equal(failedLoadVerdict(probe, false, 'x').kind, 'explain');
        assert.equal((failedLoadVerdict(probe, false, 'x') as { redirectTarget?: string }).redirectTarget, 'https://new.example.com');
    });
});

describe('redirectVerdict', () => {
    it('adopts a move that is strictly the same server', () => {
        assert.deepEqual(redirectVerdict('http://bee.example.com', 'https://bee.example.com/'), { kind: 'adopt', url: 'https://bee.example.com' });
    });

    it('explains any other move, naming the new address', () => {
        assert.deepEqual(redirectVerdict('https://bee.example.com', 'http://bee.example.com'), {
            kind: 'explain',
            error: 'Your server now sends you to http://bee.example.com.',
            code: 'redirected',
            redirectTarget: 'http://bee.example.com',
        });
        assert.equal(redirectVerdict('http://192.168.1.40:5176', 'https://evil.example.net').kind, 'explain');
        assert.equal(redirectVerdict('https://bee.example.com', 'not a url').kind, 'explain');
    });
});
