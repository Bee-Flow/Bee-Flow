import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyNetworkError } from './netErrors.ts';

const context = { url: 'https://bee.example.com/api/health', timeoutMs: 8_000, platform: 'linux' as const };

/** What Chromium's net.request rejects with: the code, and only the code. */
function chromium(code: string): Error {
    return new Error(`net::${code}`);
}

/** What Node's fetch rejects with: 'fetch failed', the reason in `cause`. */
function undici(code: string, message = code): Error {
    const error = new TypeError('fetch failed');
    (error as Error & { cause?: unknown }).cause = { code, message };
    return error;
}

describe('classifyNetworkError — Chromium', () => {
    const cases: Array<[string, string, RegExp]> = [
        ['ERR_NAME_NOT_RESOLVED', 'dns', /could not be found/],
        ['ERR_CONNECTION_REFUSED', 'refused', /nothing is listening/],
        ['ERR_CONNECTION_RESET', 'refused', /closed the connection/],
        ['ERR_CONNECTION_TIMED_OUT', 'timeout', /No answer from bee\.example\.com within 8 seconds/],
        ['ERR_INTERNET_DISCONNECTED', 'offline', /not connected to a network/],
        ['ERR_CERT_AUTHORITY_INVALID', 'tls', /not signed by an authority this computer trusts/],
        ['ERR_CERT_DATE_INVALID', 'tls', /expired, or is not valid yet/],
        ['ERR_CERT_COMMON_NAME_INVALID', 'tls', /different host name/],
        ['ERR_CERT_REVOKED', 'tls', /revoked/],
        ['ERR_SSL_VERSION_OR_CIPHER_MISMATCH', 'tls', /TLS 1\.2/],
        ['ERR_SSL_CLIENT_AUTH_CERT_NEEDED', 'tls', /client certificate/],
        ['ERR_PROXY_CONNECTION_FAILED', 'proxy', /proxy/],
        ['ERR_TUNNEL_CONNECTION_FAILED', 'proxy', /proxy/],
        ['ERR_TOO_MANY_REDIRECTS', 'http-error', /redirecting in a loop/],
        ['ERR_UNSAFE_PORT', 'invalid-url', /browsers refuse/],
        ['ERR_CERT_WEAK_KEY', 'tls', /ERR_CERT_WEAK_KEY/],
        ['ERR_SOMETHING_NEW', 'unknown', /ERR_SOMETHING_NEW/],
    ];
    for (const [code, expected, message] of cases) {
        it(`reads net::${code}`, () => {
            const result = classifyNetworkError(chromium(code), context);
            assert.equal(result.code, expected, code);
            assert.match(result.message, message, code);
        });
    }

    it('does not mistake a proxy certificate problem for the server certificate', () => {
        // A substring match on "CERT" used to send this to TLS advice about
        // the server, which is the wrong machine to fix.
        assert.equal(classifyNetworkError(chromium('ERR_PROXY_CERTIFICATE_INVALID'), context).code, 'proxy');
    });

    it('marks what https-to-an-http-port looks like, and nothing else', () => {
        assert.equal(classifyNetworkError(chromium('ERR_SSL_PROTOCOL_ERROR'), context).speaksHttp, true);
        assert.equal(classifyNetworkError(chromium('ERR_EMPTY_RESPONSE'), context).speaksHttp, true);
        assert.equal(classifyNetworkError(chromium('ERR_CONNECTION_CLOSED'), context).speaksHttp, true);
        // A certificate error is a real https server with a real problem —
        // falling back to http there would route around the problem.
        assert.equal(classifyNetworkError(chromium('ERR_CERT_AUTHORITY_INVALID'), context).speaksHttp, false);
        assert.equal(classifyNetworkError(chromium('ERR_CERT_DATE_INVALID'), context).speaksHttp, false);
    });

    it('points a Mac at the Local Network permission', () => {
        const mac = classifyNetworkError(chromium('ERR_ADDRESS_UNREACHABLE'), { ...context, platform: 'darwin' });
        assert.match(mac.message, /Local Network/);
        const linux = classifyNetworkError(chromium('ERR_ADDRESS_UNREACHABLE'), context);
        assert.doesNotMatch(linux.message, /Local Network/);
    });

    it('explains how to trust a private CA on each platform, and never how to skip the check', () => {
        const linux = classifyNetworkError(chromium('ERR_CERT_AUTHORITY_INVALID'), context).message;
        assert.match(linux, /certutil -d sql:\$HOME\/\.pki\/nssdb/);
        assert.match(classifyNetworkError(chromium('ERR_CERT_AUTHORITY_INVALID'), { ...context, platform: 'darwin' }).message, /Keychain Access/);
        assert.match(classifyNetworkError(chromium('ERR_CERT_AUTHORITY_INVALID'), { ...context, platform: 'win32' }).message, /certmgr\.msc/);
        assert.match(linux, /will not skip the check/);
    });
});

describe('classifyNetworkError — Node fetch', () => {
    const cases: Array<[string, string, RegExp]> = [
        ['ENOTFOUND', 'dns', /could not be found/],
        ['ECONNREFUSED', 'refused', /nothing is listening/],
        ['ECONNRESET', 'refused', /closed the connection/],
        ['EHOSTUNREACH', 'offline', /no route/],
        ['UND_ERR_CONNECT_TIMEOUT', 'timeout', /No answer/],
        ['CERT_HAS_EXPIRED', 'tls', /has expired/],
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls', /not signed by an authority/],
        ['SELF_SIGNED_CERT_IN_CHAIN', 'tls', /not signed by an authority/],
        ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls', /not signed by an authority/],
        ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls', /different host name/],
    ];
    for (const [code, expected, message] of cases) {
        it(`reads ${code}`, () => {
            const result = classifyNetworkError(undici(code), context);
            assert.equal(result.code, expected, code);
            assert.match(result.message, message, code);
        });
    }

    it('names an incomplete chain instead of saying "fetch failed"', () => {
        // Neither the code nor 'fetch failed' contains CERT/SSL/TLS, so this
        // used to fall all the way through and show the user "fetch failed".
        const result = classifyNetworkError(undici('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'), context);
        assert.equal(result.code, 'tls');
        assert.match(result.message, /fullchain\.pem/);
    });

    it('marks an http port answering a TLS handshake', () => {
        const result = classifyNetworkError(undici('ERR_SSL_PACKET_LENGTH_TOO_LONG', 'packet length too long'), context);
        assert.equal(result.speaksHttp, true);
        assert.equal(classifyNetworkError(undici('ERR_SSL_WRONG_VERSION_NUMBER'), context).speaksHttp, true);
    });

    it('reports an abort as a timeout', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        assert.equal(classifyNetworkError(error, context).code, 'timeout');
    });

    it('shows the real reason when nothing matched', () => {
        const result = classifyNetworkError(undici('EWHATEVER', 'the reason'), context);
        assert.equal(result.code, 'unknown');
        assert.equal(result.message, 'the reason');
    });
});
