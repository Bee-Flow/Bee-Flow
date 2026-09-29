import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { davUserOf, encodeRemotePath, loginFlowUrl, userMetadataUrl, webdavUrl, webUrl } from './links.ts';

const account = { url: 'https://cloud.example.com', user: 'tom', davUser: 'tom' };
const subpath = { url: 'https://example.org/nextcloud', user: 't.kooy', davUser: 't.kooy' };

describe('encodeRemotePath', () => {
    it('encodes the segments and keeps the separators', () => {
        assert.equal(encodeRemotePath('/Projecten/Bee Flow/nota #3.pdf'), '/Projecten/Bee%20Flow/nota%20%233.pdf');
    });

    it('survives the characters a European filename actually has', () => {
        assert.equal(encodeRemotePath('/Bel채gg/r채kning.pdf'.normalize()), encodeRemotePath('/Bel채gg/r채kning.pdf'));
        assert.equal(decodeURIComponent(encodeRemotePath('/Projecten/Überprüfung.docx')), '/Projecten/Überprüfung.docx');
    });

    it('leaves the root alone', () => {
        assert.equal(encodeRemotePath('/'), '/');
    });
});

describe('webdavUrl', () => {
    it('builds the path the Bee Flow server fetches', () => {
        assert.equal(
            webdavUrl(account, '/Projecten/nota.pdf'),
            'https://cloud.example.com/remote.php/dav/files/tom/Projecten/nota.pdf',
        );
    });

    it('keeps a subpath install intact', () => {
        assert.equal(
            webdavUrl(subpath, '/nota.pdf'),
            'https://example.org/nextcloud/remote.php/dav/files/t.kooy/nota.pdf',
        );
    });

    it('uses the DAV user, which an SSO account spells differently', () => {
        const sso = { url: 'https://cloud.example.com', user: 'tom@example.com', davUser: 'a1b2c3d4-uuid' };
        assert.equal(davUserOf(sso), 'a1b2c3d4-uuid');
        assert.match(webdavUrl(sso, '/x.txt'), /\/files\/a1b2c3d4-uuid\/x\.txt$/);
    });

    it('falls back to the login name when there is no DAV user', () => {
        assert.equal(davUserOf({ user: 'tom' }), 'tom');
        assert.match(webdavUrl({ url: 'https://c.example', user: 'tom' }, '/x'), /\/files\/tom\/x$/);
    });

    it('encodes a user name that needs it', () => {
        assert.match(webdavUrl({ url: 'https://c.example', user: 'tom kooy' }, '/x'), /\/files\/tom%20kooy\/x$/);
    });

    it('addresses the account root without a dangling slash', () => {
        assert.equal(webdavUrl(account, '/'), 'https://cloud.example.com/remote.php/dav/files/tom');
    });
});

describe('webUrl', () => {
    it('opens a folder directly', () => {
        assert.equal(
            webUrl(account, '/Projecten/Bee Flow', true),
            'https://cloud.example.com/index.php/apps/files/?dir=%2FProjecten%2FBee%20Flow',
        );
    });

    it('opens a file by scrolling its folder to it', () => {
        assert.equal(
            webUrl(account, '/Projecten/nota.pdf', false),
            'https://cloud.example.com/index.php/apps/files/?dir=%2FProjecten&scrollto=nota.pdf',
        );
    });

    it('handles a file in the root', () => {
        assert.equal(webUrl(account, '/nota.pdf', false), 'https://cloud.example.com/index.php/apps/files/?dir=%2F&scrollto=nota.pdf');
    });
});

describe('endpoint helpers', () => {
    it('point at the documented paths', () => {
        assert.equal(loginFlowUrl('https://cloud.example.com/'), 'https://cloud.example.com/index.php/login/v2');
        assert.equal(userMetadataUrl('https://cloud.example.com'), 'https://cloud.example.com/ocs/v2.php/cloud/user?format=json');
    });
});
