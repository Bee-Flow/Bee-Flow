/**
 * A hint that a person's cloud storage changed (core/kb/sources/cloudFolderEvents.mts)
 * arms that person's "on change" cloud folders, and only those: the ones whose
 * folder holds the file the event names (Nextcloud), or every one at that
 * storage when the hint names no file (a OneDrive drive notification). It
 * arms, it never refreshes, and it never throws.
 *
 * Run: cd server && node --test core/kb/sources/cloudFolderEvents.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { onCloudFileEvent, isPrefixOf, normalizePath } = require('./cloudFolderEvents.mts');

const src = (id, path, over = {}) => ({ id, refreshMode: 'on_change', config: { provider: 'nextcloud_files', path }, ...over });

function world(byUser) {
    const requested = [];
    const asked = [];
    const warnings = [];
    return {
        requested, asked, warnings,
        deps: {
            listCloudFoldersByUser: async (userId, provider) => { asked.push([userId, provider]); return byUser[userId] || []; },
            requestRefresh: async (id) => { requested.push(id); },
            warn: (m) => warnings.push(m),
        },
    };
}

test('a folder is a prefix of a path at a segment boundary, never inside a name', () => {
    assert.strictEqual(isPrefixOf('/Docs', '/Docs/a.pdf'), true);
    assert.strictEqual(isPrefixOf('/Docs', '/Docs'), true);
    assert.strictEqual(isPrefixOf('Docs/', 'Docs/Sub/a.pdf'), true, 'leading and trailing slashes do not matter');
    assert.strictEqual(isPrefixOf('/Docs', '/Docs2/a.pdf'), false);
    assert.strictEqual(isPrefixOf('/Docs/Sub', '/Docs/a.pdf'), false);
    assert.strictEqual(isPrefixOf('/', '/anything/at/all'), true);
    assert.strictEqual(normalizePath('//a//b/'), '/a/b');
});

test('Nextcloud: the folders that hold the file are armed, the others and other people\'s are not', async () => {
    const w = world({
        u1: [src('s-docs', '/Docs'), src('s-sub', '/Docs/Sub'), src('s-other', '/Photos'), src('s-manual', '/Docs', { refreshMode: 'manual' }), src('s-sched', '/Docs', { refreshMode: 'schedule' })],
        u2: [src('s-u2', '/Docs')],
    });
    const out = await onCloudFileEvent({ provider: 'nextcloud_files', userId: 'u1', path: 'Docs/Sub/a.pdf' }, w.deps);
    assert.deepStrictEqual(w.requested.sort(), ['s-docs', 's-sub']);
    assert.strictEqual(out.requested, 2);
    assert.deepStrictEqual(w.asked, [['u1', 'nextcloud_files']], 'only the actor\'s own sources are looked up');
});

test('Nextcloud: a rename also arms the folder the file came from', async () => {
    const w = world({ u1: [src('s-old', '/Inbox'), src('s-new', '/Archive')] });
    await onCloudFileEvent({ provider: 'nextcloud_files', userId: 'u1', path: '/Archive/a.pdf', oldPath: '/Inbox/a.pdf' }, w.deps);
    assert.deepStrictEqual(w.requested.sort(), ['s-new', 's-old']);
});

test('Nextcloud: an event that names no path arms nothing', async () => {
    const w = world({ u1: [src('s1', '/Docs')] });
    await onCloudFileEvent({ provider: 'nextcloud_files', userId: 'u1' }, w.deps);
    assert.deepStrictEqual(w.requested, []);
});

test('OneDrive: a drive hint names no file, so every on-change folder of that person at that storage is armed', async () => {
    const w = world({ u1: [
        { id: 'od1', refreshMode: 'on_change', config: { provider: 'onedrive', folderId: 'F' } },
        { id: 'od2', refreshMode: 'on_change', config: { provider: 'onedrive', folderId: 'G' } },
        { id: 'od3', refreshMode: 'schedule', config: { provider: 'onedrive', folderId: 'H' } },
    ] });
    const out = await onCloudFileEvent({ provider: 'onedrive', userId: 'u1' }, w.deps);
    assert.deepStrictEqual(w.requested, ['od1', 'od2']);
    assert.strictEqual(out.requested, 2);
    assert.deepStrictEqual(w.asked, [['u1', 'onedrive']]);
});

test('a person with no cloud folders, or an event without a person, does nothing', async () => {
    const w = world({});
    assert.deepStrictEqual(await onCloudFileEvent({ provider: 'nextcloud_files', userId: 'nobody', path: '/x' }, w.deps), { requested: 0 });
    assert.deepStrictEqual(await onCloudFileEvent({ provider: 'nextcloud_files', userId: '', path: '/x' }, w.deps), { requested: 0 });
    assert.deepStrictEqual(await onCloudFileEvent(null, w.deps), { requested: 0 });
    assert.deepStrictEqual(w.asked, [['nobody', 'nextcloud_files']]);
});

test('failures are logged and swallowed: one source failing does not stop the others, a failing lookup does not throw', async () => {
    const w = world({ u1: [src('bad', '/Docs'), src('good', '/Docs')] });
    w.deps.requestRefresh = async (id) => { if (id === 'bad') throw new Error('db down'); w.requested.push(id); };
    const out = await onCloudFileEvent({ provider: 'nextcloud_files', userId: 'u1', path: '/Docs/a.pdf' }, w.deps);
    assert.deepStrictEqual(w.requested, ['good']);
    assert.strictEqual(out.requested, 1);
    assert.match(w.warnings[0], /could not arm source bad: db down/);

    const broken = world({});
    broken.deps.listCloudFoldersByUser = async () => { throw new Error('no table'); };
    assert.deepStrictEqual(await onCloudFileEvent({ provider: 'onedrive', userId: 'u1' }, broken.deps), { requested: 0 });
    assert.match(broken.warnings[0], /not handled: no table/);
});
