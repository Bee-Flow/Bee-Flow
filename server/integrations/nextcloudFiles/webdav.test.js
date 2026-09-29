/**
 * The WebDAV plumbing the file tools and the spreadsheet mirror share: the
 * PROPFIND body asks for the etag, the permission string and the owner id
 * (added for the mirror, harmless for the list tool), parsePropfind hands
 * them through — the etag verbatim, quotes included, because it goes back to
 * Nextcloud in an If-Match header — and the entries the list tool always
 * read (name, path, type, size, contentType, modified, fileId) are unchanged.
 *
 * '../nextcloudClient' is stubbed: it pulls the database in at load time.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/webdav.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const restore = installResolveStub({
    '../nextcloudClient': { REQUEST_TIMEOUT_MS: 20000, webdavRoot: (b, u) => `${b}/remote.php/dav/files/${u}` },
});
const webdav = require('./webdav');
test.after(() => restore());

const BASE = 'https://nc.example.test';

const XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Documents/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
      <d:getlastmodified>Tue, 01 Sep 2026 10:00:00 GMT</d:getlastmodified>
      <oc:fileid>1</oc:fileid>
      <d:getetag>"folder-etag"</d:getetag>
      <oc:permissions>RGDNVCK</oc:permissions>
      <oc:owner-id>alice</oc:owner-id>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Documents/Facturen%20Q3.xlsx</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>4096</d:getcontentlength>
      <d:getcontenttype>application/vnd.openxmlformats-officedocument.spreadsheetml.sheet</d:getcontenttype>
      <d:getlastmodified>Tue, 01 Sep 2026 10:00:00 GMT</d:getlastmodified>
      <oc:fileid>42</oc:fileid>
      <d:getetag>"abc123"</d:getetag>
      <oc:permissions>RGDNVW</oc:permissions>
      <oc:owner-id>bob</oc:owner-id>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Documents/old.csv</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>10</d:getcontentlength>
      <oc:fileid>43</oc:fileid>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    <d:propstat><d:prop><d:getetag/><oc:permissions/><oc:owner-id/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

test('PROPFIND_BODY asks for the etag, the permissions and the owner id beside the original props', () => {
    for (const tag of ['d:displayname', 'd:getcontentlength', 'd:getcontenttype', 'd:getlastmodified', 'd:resourcetype', 'oc:fileid', 'oc:size', 'd:getetag', 'oc:permissions', 'oc:owner-id']) {
        assert.ok(webdav.PROPFIND_BODY.includes(`<${tag}/>`), `${tag} requested`);
    }
    assert.match(webdav.PROPFIND_BODY, /xmlns:oc="http:\/\/owncloud\.org\/ns"/);
});

test('parsePropfind: the original entry shape is unchanged and etag / permissions / ownerId ride along', () => {
    const [folder, file, old] = webdav.parsePropfind(XML, BASE, 'alice');
    assert.deepEqual(folder, { name: 'Documents', path: '/Documents', type: 'folder', size: undefined, contentType: undefined, modified: 'Tue, 01 Sep 2026 10:00:00 GMT', fileId: '1', etag: '"folder-etag"', permissions: 'RGDNVCK', ownerId: 'alice' });
    assert.deepEqual(file, { name: 'Facturen Q3.xlsx', path: '/Documents/Facturen Q3.xlsx', type: 'file', size: 4096, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modified: 'Tue, 01 Sep 2026 10:00:00 GMT', fileId: '42', etag: '"abc123"', permissions: 'RGDNVW', ownerId: 'bob' });
    assert.equal(file.etag, '"abc123"', 'quotes kept — If-Match wants the quoted form');
    // A server that does not know the new props answers them in a 404
    // propstat, which is dropped: the entry still parses, the fields are null.
    assert.equal(old.name, 'old.csv');
    assert.equal(old.size, 10);
    assert.equal(old.etag, null);
    assert.equal(old.permissions, null);
    assert.equal(old.ownerId, null);
});

test('joinDavPath and relativeFromRoot stay inverse of each other around the new props', () => {
    const root = `${BASE}/remote.php/dav/files/alice`;
    assert.equal(webdav.joinDavPath(root, '/Documents/Facturen Q3.xlsx'), `${root}/Documents/Facturen%20Q3.xlsx`);
    assert.equal(webdav.relativeFromRoot('/remote.php/dav/files/alice/Documents/Facturen%20Q3.xlsx', BASE, 'alice'), '/Documents/Facturen Q3.xlsx');
});
