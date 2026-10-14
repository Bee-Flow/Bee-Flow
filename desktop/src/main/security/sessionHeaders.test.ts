import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clientHeaderFor, withClientHeader } from './sessionHeaders.ts';

const server = { url: 'https://bee.example.com/workspace', apiOrigin: 'https://api.bee.example.com' };

describe('clientHeaderFor', () => {
    it('announces the client to the server and its API origin', () => {
        assert.equal(clientHeaderFor('https://bee.example.com/api/health', server), true);
        assert.equal(clientHeaderFor('https://api.bee.example.com/auth/login', server), true);
    });

    it('says nothing to anyone else, an identity provider included', () => {
        assert.equal(clientHeaderFor('https://login.microsoftonline.com/authorize', server), false);
        assert.equal(clientHeaderFor('http://bee.example.com/api/health', server), false, 'another scheme is another origin');
        assert.equal(clientHeaderFor('not a url', server), false);
    });

    it('sends nothing before a server is configured', () => {
        assert.equal(clientHeaderFor('https://bee.example.com/', { url: '' }), false);
        assert.equal(clientHeaderFor('https://bee.example.com/', { url: '', apiOrigin: '' }), false);
    });
});

describe('withClientHeader', () => {
    it('adds the header without touching the others', () => {
        const headers = { Accept: 'text/html' };
        assert.deepEqual(withClientHeader(headers, 'https://bee.example.com/', server), { Accept: 'text/html', 'X-Beeflow-Client': 'desktop' });
        assert.deepEqual(headers, { Accept: 'text/html' });
    });

    it('hands back the very same headers for another origin', () => {
        const headers = { Accept: 'text/html' };
        assert.equal(withClientHeader(headers, 'https://idp.example.net/', server), headers);
    });
});
