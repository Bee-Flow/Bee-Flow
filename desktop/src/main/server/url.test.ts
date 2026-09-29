import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hostKind, isSameServer, normaliseServerUrl, originOf, serverUrl, withHttp } from './url.ts';

describe('normaliseServerUrl', () => {
    it('assumes https when no scheme was typed', () => {
        const result = normaliseServerUrl('bee.example.com');
        assert.equal(result.ok && result.url, 'https://bee.example.com');
        assert.equal(result.ok && result.insecure, false);
    });

    it('keeps a subpath install intact', () => {
        const result = normaliseServerUrl('https://cloud.example.com/beeflow/');
        assert.equal(result.ok && result.url, 'https://cloud.example.com/beeflow');
    });

    it('keeps an explicit port', () => {
        const result = normaliseServerUrl('http://192.168.1.40:3101');
        assert.equal(result.ok && result.url, 'http://192.168.1.40:3101');
    });

    it('drops the SPA route someone copied out of the address bar', () => {
        for (const [input, expected] of [
            ['https://bee.example.com/app/chat/123', 'https://bee.example.com'],
            ['https://bee.example.com/login', 'https://bee.example.com'],
            ['https://cloud.example.com/beeflow/app', 'https://cloud.example.com/beeflow'],
            ['https://bee.example.com/api', 'https://bee.example.com'],
        ] as const) {
            const result = normaliseServerUrl(input);
            assert.equal(result.ok && result.url, expected, input);
        }
    });

    it('flags plain http to any other machine, and only there', () => {
        // "Not encrypted" is about the wire, not about trust: a LAN address is
        // still a network hop, so the UI says so. This computer is not.
        const lan = normaliseServerUrl('http://192.168.1.40:3101');
        assert.equal(lan.ok && lan.insecure, true);

        const wan = normaliseServerUrl('http://bee.example.com');
        assert.equal(wan.ok && wan.url, 'http://bee.example.com');
        assert.equal(wan.ok && wan.insecure, true, 'accepted, but the UI has to say what it costs');

        const loopback = normaliseServerUrl('http://localhost:5176');
        assert.equal(loopback.ok && loopback.insecure, false);
    });

    it('says whether a scheme and a port were typed', () => {
        const bare = normaliseServerUrl('192.168.1.40:5176');
        assert.deepEqual(bare.ok && [bare.schemeTyped, bare.portTyped], [false, true]);
        const typed = normaliseServerUrl('https://bee.example.com');
        assert.deepEqual(typed.ok && [typed.schemeTyped, typed.portTyped], [true, false]);
        const ipv6 = normaliseServerUrl('[fd00::1]:5176');
        assert.deepEqual(ipv6.ok && [ipv6.url, ipv6.portTyped], ['https://[fd00::1]:5176', true]);
    });

    it('refuses credentials in the address', () => {
        const result = normaliseServerUrl('https://admin:secret@bee.example.com');
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /sign in on the next page/);
    });

    it('names a scheme it cannot speak', () => {
        const result = normaliseServerUrl('ftp://bee.example.com');
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /not ftp/);
    });

    it('rejects an empty value with an instruction, not a complaint', () => {
        const result = normaliseServerUrl('   ');
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /Enter the address/);
    });

    it('accepts a machine name on the local network', () => {
        // `nas`, `homeserver`: a LAN resolver answers these, and they are how
        // plenty of people reach a server in a cupboard.
        const result = normaliseServerUrl('http://nas:5176');
        assert.equal(result.ok && result.url, 'http://nas:5176');
    });

    it('accepts localhost without a domain', () => {
        assert.equal(normaliseServerUrl('localhost:3101').ok, true);
        assert.equal(normaliseServerUrl('http://localhost').ok, true);
    });
});

describe('hostKind', () => {
    it('knows this computer', () => {
        for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]']) {
            assert.equal(hostKind(host), 'loopback', host);
        }
    });

    it('knows the private address ranges, including Tailscale and IPv6', () => {
        for (const host of ['10.0.0.5', '192.168.1.40', '172.16.0.1', '172.31.255.255', '100.64.0.1', '100.127.255.254', '169.254.10.1', 'fd12:3456::1', '[fe80::1]']) {
            assert.equal(hostKind(host), 'private', host);
        }
    });

    it('keeps names a local resolver answers apart from IP literals', () => {
        // Whoever runs the network decides what these resolve to, so they
        // never get the silent http fallback a private IP gets.
        for (const host of ['nas', 'nas.local', 'bee.lan', 'x.internal', 'x.home.arpa', 'NAS.LOCAL.']) {
            assert.equal(hostKind(host), 'lan-name', host);
        }
    });

    it('treats everything else as public', () => {
        for (const host of ['bee.example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '100.128.0.1', '2001:db8::1', '300.1.1.1']) {
            assert.equal(hostKind(host), 'public', host);
        }
    });
});

describe('withHttp', () => {
    it('keeps host, port and path', () => {
        assert.equal(withHttp('https://192.168.1.40:5176'), 'http://192.168.1.40:5176');
        assert.equal(withHttp('https://cloud.example.com/beeflow'), 'http://cloud.example.com/beeflow');
    });
});

describe('isSameServer', () => {
    it('ignores the differences that do not change which server it is', () => {
        assert.equal(isSameServer('bee.example.com', 'https://bee.example.com/'), true);
        assert.equal(isSameServer('https://bee.example.com/app/chat', 'https://bee.example.com'), true);
        assert.equal(isSameServer('https://bee.example.com', 'https://other.example.com'), false);
        assert.equal(isSameServer('https://cloud.example.com/beeflow', 'https://cloud.example.com'), false);
    });
});

describe('serverUrl / originOf', () => {
    it('joins without doubling or dropping a slash', () => {
        assert.equal(serverUrl('https://bee.example.com', '/api/health'), 'https://bee.example.com/api/health');
        assert.equal(serverUrl('https://bee.example.com/', 'api/health'), 'https://bee.example.com/api/health');
        assert.equal(serverUrl('https://cloud.example.com/beeflow', '/api/health'), 'https://cloud.example.com/beeflow/api/health');
    });

    it('returns the origin, or null for a non-URL', () => {
        assert.equal(originOf('https://bee.example.com/beeflow'), 'https://bee.example.com');
        assert.equal(originOf('not a url'), null);
    });
});

describe('normaliseServerUrl — path segments that only look like SPA routes', () => {
    it('leaves a server whose own path merely starts with the same letters alone', () => {
        for (const input of ['https://example.com/app-gateway', 'https://example.com/applications/bee', 'https://example.com/apis']) {
            const result = normaliseServerUrl(input);
            assert.equal(result.ok && result.url, input, input);
        }
    });
});
