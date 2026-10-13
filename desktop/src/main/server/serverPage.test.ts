import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isServerNavigation, isUnencrypted, titleSuffix } from './serverPage.ts';

describe('isServerNavigation', () => {
    it('matches the configured server by origin', () => {
        assert.equal(isServerNavigation('https://bee.example.com/app/chat', 'https://bee.example.com'), true);
        assert.equal(isServerNavigation('https://bee.example.com:8443/', 'https://bee.example.com'), false);
        assert.equal(isServerNavigation('https://idp.example.net/login', 'https://bee.example.com'), false);
    });

    it('matches nothing before a server is configured', () => {
        assert.equal(isServerNavigation('https://bee.example.com/', ''), false);
        assert.equal(isServerNavigation('', ''), false);
    });
});

describe('isUnencrypted', () => {
    it('flags plain http to another machine', () => {
        assert.equal(isUnencrypted('http://192.168.1.40:5176/chat', 'http://192.168.1.40:5176'), true);
        assert.equal(isUnencrypted('http://nas.local/', 'http://nas.local'), true);
    });

    it('does not flag https, this machine, or another origin', () => {
        assert.equal(isUnencrypted('https://bee.example.com/', 'https://bee.example.com'), false);
        assert.equal(isUnencrypted('http://localhost:5176/', 'http://localhost:5176'), false);
        assert.equal(isUnencrypted('http://127.0.0.1:5176/', 'http://127.0.0.1:5176'), false);
        assert.equal(isUnencrypted('http://evil.example.net/', 'http://192.168.1.40:5176'), false);
        assert.equal(isUnencrypted('http://192.168.1.40:5176/', ''), false);
    });
});

describe('titleSuffix', () => {
    it('adds nothing to our own pages or an encrypted server', () => {
        assert.equal(titleSuffix('', 'https://bee.example.com'), '');
        assert.equal(titleSuffix('file:///opt/beeflow/shell/welcome.html', 'https://bee.example.com'), '');
        assert.equal(titleSuffix('https://bee.example.com/chat', 'https://bee.example.com'), '');
    });

    it('says when the server is not encrypted', () => {
        assert.equal(titleSuffix('http://192.168.1.40:5176/chat', 'http://192.168.1.40:5176'), 'not encrypted');
    });

    it('names the host of any other page in the window', () => {
        assert.equal(titleSuffix('https://login.microsoftonline.com/common/oauth2', 'https://bee.example.com'), 'login.microsoftonline.com');
        assert.equal(titleSuffix('not a url', 'https://bee.example.com'), '');
    });
});
