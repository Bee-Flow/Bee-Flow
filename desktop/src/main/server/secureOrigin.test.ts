import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { savedServerUrl, secureContextOrigin } from './secureOrigin.ts';

describe('secureContextOrigin', () => {
    it('marks plain http on a private IP address', () => {
        assert.equal(secureContextOrigin('http://192.168.1.40:5176'), 'http://192.168.1.40:5176');
        assert.equal(secureContextOrigin('http://10.0.0.7/beeflow'), 'http://10.0.0.7', 'the origin, not the path');
        assert.equal(secureContextOrigin('http://100.101.102.103:5176'), 'http://100.101.102.103:5176', 'Tailscale');
    });

    it('leaves everything else alone', () => {
        for (const url of [
            'https://192.168.1.40:5176', // already secure
            'http://localhost:5176', // already secure
            'http://127.0.0.1:5176', // already secure
            'http://nas.local:5176', // a name the current network decides
            'http://nas:5176',
            'http://bee.example.com', // not the user's network at all
            'http://8.8.8.8',
            '',
            'not a url',
        ]) {
            assert.equal(secureContextOrigin(url), null, url);
        }
    });
});

describe('savedServerUrl', () => {
    it('reads the server from the settings file', () => {
        assert.equal(savedServerUrl(() => JSON.stringify({ server: { url: 'http://192.168.1.40:5176' } })), 'http://192.168.1.40:5176');
    });

    it('fails closed on anything unexpected', () => {
        assert.equal(
            savedServerUrl(() => {
                throw new Error('ENOENT');
            }),
            '',
        );
        assert.equal(savedServerUrl(() => '{ not json'), '');
        assert.equal(savedServerUrl(() => JSON.stringify({ server: { url: 42 } })), '');
        assert.equal(savedServerUrl(() => 'null'), '');
    });
});
