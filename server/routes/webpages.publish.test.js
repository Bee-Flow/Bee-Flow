/**
 * routes/webpages — the publish lifecycle (W2).
 *
 * Before this stage "Publish" set a visibility flag and nothing else, so an
 * org reader was served the OWNER'S LIVE ROW: the last keystroke, published
 * or not. What is pinned here is the whole path that fixes it, refusal cases
 * first, because those are where the leak comes back:
 *
 *   PUBLISH  flush → snapshot → pointer, in that order (a pointer written
 *            before its version exists is a window in which readers get
 *            nothing; a snapshot taken before the SQLite flush pins stale
 *            data). A pin that fails is a 500, never a cheerful success.
 *   AUDIENCE ticking a group is not a re-publish: it must not re-pin, or
 *            every checkbox would push the owner's newest work to the
 *            audience under the guise of a sharing change.
 *   UNPUBLISH clears the pointer — a page with no audience must not keep one.
 *   READ     a non-owner gets the pinned bytes; a pointer whose version is
 *            gone yields EMPTY content, never a fall-back to the live row.
 *   IMAGE    the thumbnail is a screenshot of the LIVE page, so a non-owner
 *            only gets it while live and published are the same three files.
 *
 * No DB: auth is stubbed before the router loads and every store touch is
 * monkey-patched (same pattern as webpages.create.test.js).
 *
 * Run: node --test --test-force-exit routes/webpages.publish.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

const perms = require('../auth/permissions');
perms.requireAuth = (req, res, next) => next();
const auth = require('../auth');
auth.requireActiveOrgForMutations = () => (req, res, next) => next();
auth.validateSharedGroupsForOrg = async (_org, groups) => (Array.isArray(groups) ? groups : []);
auth.hasPermission = async () => false;
const audience = require('../auth/audience');
audience.resolveAudienceContext = async (req) => ({
    userId: req.session.user.id, orgIds: ['org1'], userGroups: [],
});

const webpageStore = require('../stores/webpageStore');
const webpageDbStore = require('../stores/webpageDbStore');
const publicShareStore = require('../stores/webpagePublicShareStore');

const webpagesRouter = require('./webpages');

const OWNER = { id: 'alice', organizationId: 'org1' };
const READER = { id: 'bob', organizationId: 'org1' };

const BASE_PAGE = {
    id: 'wp1', userId: 'alice', name: 'Page', isPublished: false, sharedGroups: [],
    organizationId: 'org1', publishedVersionId: null, projectId: null,
    htmlSha: 'h1', cssSha: 'c1', jsSha: 'j1', dbSha: '',
    htmlSize: 10, cssSize: 5, jsSize: 5, dbSize: 0,
    thumbnailSha: 'thumb1', settings: {},
};

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => { for (const [obj, key, orig] of originals) obj[key] = orig; });
}

async function withServer(t, sessionUser, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...sessionUser } }; next(); });
    app.use(webpagesRouter);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

function patch(page, calls, over = {}) {
    return [
        [publicShareStore, 'countLiveSharesForWebpages', async (ids) => new Map(ids.map(i => [i, 0]))],
        [webpageDbStore, 'flush', async (u, id) => { calls.order.push(`flush:${id}`); }],
        [webpageStore, 'getWebpageRaw', async () => ({ ...page })],
        [webpageStore, 'getWebpage', async (id, userId) => (userId === page.userId ? { ...page } : null)],
        [webpageStore, 'setWebpagePublished', async (id, isPublished, ownerId, groups) => {
            calls.order.push('setPublished');
            calls.published.push({ id, isPublished, ownerId, groups });
            return true;
        }],
        [webpageStore, 'createVersion', async (userId, id, summary, hashes, source) => {
            calls.order.push(`createVersion:${source}`);
            calls.versions.push({ userId, id, summary, hashes, source });
            return { id: 'v-new' };
        }],
        [webpageStore, 'setPublishedVersion', async (id, ownerId, versionId) => {
            calls.order.push(`setPointer:${versionId === null ? 'null' : versionId}`);
            calls.pointers.push({ id, ownerId, versionId });
            return true;
        }],
        ...Object.entries(over).map(([k, v]) => [webpageStore, k, v]),
    ];
}

function newCalls() { return { order: [], published: [], versions: [], pointers: [] }; }

const publish = (base, body) => fetch(`${base}/wp1/publish`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ── Publish pins ──────────────────────────────────────────────────────

test('a first publish flushes, snapshots and THEN points — in that order', async (t) => {
    const calls = newCalls();
    await withPatches(patch(BASE_PAGE, calls), () => withServer(t, OWNER, async (base) => {
        const res = await publish(base, { isPublished: true, sharedGroups: [] });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.publishedVersionId, 'v-new');

        assert.deepStrictEqual(
            calls.order.filter(o => o !== 'setPublished'),
            ['flush:wp1', 'createVersion:published', 'setPointer:v-new'],
            'a pointer written before its version exists is a window in which readers get nothing');
        assert.strictEqual(calls.versions[0].source, 'published',
            'the snapshot must carry the source the prune protects');
    }));
});

test('a pin that fails is a 500, not a successful publish', async (t) => {
    const calls = newCalls();
    const patches = patch(BASE_PAGE, calls, {
        setPublishedVersion: async () => false,   // e.g. the row vanished mid-flight
    });
    await withPatches(patches, () => withServer(t, OWNER, async (base) => {
        const res = await publish(base, { isPublished: true, sharedGroups: [] });
        assert.strictEqual(res.status, 500,
            'reporting success with nothing pinned would leave the audience on live bytes');
        const body = await res.json();
        assert.ok(!body.success);
        // THE POINT OF THE 500. Asserting the status alone passed even while
        // the flag was flipped BEFORE the pin: the caller saw an error and the
        // page was published anyway, with published_version_id NULL — which
        // resolveReadVersion answers by serving the LIVE row. The refusal has
        // to leave the page exactly as it was found.
        assert.strictEqual(calls.published.length, 0,
            'a failed pin must not publish: no audience may be given a page with no frozen snapshot');
        assert.ok(!calls.order.includes('setPublished'),
            'the visibility flag must not be written before the snapshot exists');
    }));
});

test('a snapshot that throws is a 500 too', async (t) => {
    const calls = newCalls();
    const patches = patch(BASE_PAGE, calls, {
        createVersion: async () => { throw new Error('object storage down'); },
    });
    await withPatches(patches, () => withServer(t, OWNER, async (base) => {
        const res = await publish(base, { isPublished: true, sharedGroups: [] });
        assert.strictEqual(res.status, 500);
        assert.strictEqual(calls.pointers.length, 0, 'and no pointer may be written');
        assert.strictEqual(calls.published.length, 0,
            'nor may the page be published — a snapshot that never existed cannot be what the audience reads');
    }));
});

// ── Audience changes are not re-publishes ─────────────────────────────

test('ticking a group on an already-pinned page does NOT re-pin', async (t) => {
    const calls = newCalls();
    const live = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old' };
    await withPatches(patch(live, calls), () => withServer(t, OWNER, async (base) => {
        const res = await publish(base, { isPublished: true, sharedGroups: ['g1'] });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(calls.versions, [],
            'a sharing change must not push the owner\'s newest work to the audience');
        assert.deepStrictEqual(calls.pointers, []);
        assert.strictEqual((await res.json()).publishedVersionId, 'v-old', 'the existing pin stands');
    }));
});

test('an explicit republish DOES re-pin', async (t) => {
    const calls = newCalls();
    const live = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old' };
    await withPatches(patch(live, calls), () => withServer(t, OWNER, async (base) => {
        const res = await publish(base, { isPublished: true, sharedGroups: [], republish: true });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls.versions.length, 1);
        assert.strictEqual((await res.json()).publishedVersionId, 'v-new');
    }));
});

test('a published page that somehow has no pointer gets one, even without republish', async (t) => {
    const calls = newCalls();
    const live = { ...BASE_PAGE, isPublished: true, publishedVersionId: null };
    await withPatches(patch(live, calls), () => withServer(t, OWNER, async (base) => {
        await publish(base, { isPublished: true, sharedGroups: ['g1'] });
        assert.strictEqual(calls.versions.length, 1,
            'no pointer means the read path is on its documented fall-back — close it');
    }));
});

// ── Unpublish ─────────────────────────────────────────────────────────

test('unpublishing clears the pointer', async (t) => {
    const calls = newCalls();
    const live = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old' };
    await withPatches(patch(live, calls), () => withServer(t, OWNER, async (base) => {
        const res = await publish(base, { isPublished: false, sharedGroups: [] });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(calls.pointers, [{ id: 'wp1', ownerId: 'alice', versionId: null }]);
        assert.deepStrictEqual(calls.versions, [], 'unpublishing snapshots nothing');
        assert.strictEqual((await res.json()).publishedVersionId, null);
    }));
});

// ── The read path ─────────────────────────────────────────────────────

function readPatches(page, over = {}) {
    return [
        [publicShareStore, 'countLiveSharesForWebpages', async (ids) => new Map(ids.map(i => [i, 0]))],
        [webpageStore, 'getWebpage', async (id, userId) => (userId === page.userId ? { ...page } : null)],
        [webpageStore, 'getWebpageRaw', async () => ({ ...page })],
        [webpageStore, 'canReadWebpageAsync', async () => true],
        [webpageStore, 'getSources', async () => []],
        [webpageStore, 'listExtraFiles', async () => []],
        [webpageStore, 'getChatMessages', async () => []],
        [webpageStore, 'readAllSlots', async (u, id, versionId) => (versionId
            ? { html: `PINNED ${versionId}`, css: '', js: '' }
            : { html: 'LIVE', css: '', js: '' })],
        [webpageStore, 'getVersionMeta', async (vid) => (vid === 'v-old'
            ? { id: 'v-old', webpageId: 'wp1', htmlSha: 'h1', cssSha: 'c1', jsSha: 'j1' }
            : null)],
        ...Object.entries(over).map(([k, v]) => [webpageStore, k, v]),
    ];
}

test('the owner reads the live row', async (t) => {
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old' };
    await withPatches(readPatches(page), () => withServer(t, OWNER, async (base) => {
        const body = await (await fetch(`${base}/wp1`)).json();
        assert.strictEqual(body.files.html, 'LIVE');
        assert.strictEqual(body.servedVersionId, null);
        assert.strictEqual(body.readOnly, false);
    }));
});

test('a non-owner reads the PINNED snapshot, not the live row', async (t) => {
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old' };
    await withPatches(readPatches(page), () => withServer(t, READER, async (base) => {
        const body = await (await fetch(`${base}/wp1`)).json();
        assert.strictEqual(body.files.html, 'PINNED v-old');
        assert.strictEqual(body.servedVersionId, 'v-old');
        assert.strictEqual(body.readOnly, true);
    }));
});

test('a pointer whose version is GONE serves nothing — never the live row', async (t) => {
    // The prune now excludes pinned rows, so this should be unreachable. It is
    // pinned anyway: if it ever becomes reachable again, the failure must be an
    // empty page, not the owner's unpublished work.
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-pruned' };
    await withPatches(readPatches(page), () => withServer(t, READER, async (base) => {
        const body = await (await fetch(`${base}/wp1`)).json();
        assert.deepStrictEqual(body.files, { html: '', css: '', js: '' });
        assert.strictEqual(body.servedVersionId, null);
    }));
});

test('a pointer aimed at ANOTHER page\'s version serves nothing', async (t) => {
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-foreign' };
    const patches = readPatches(page, {
        getVersionMeta: async () => ({ id: 'v-foreign', webpageId: 'wp-other', htmlSha: 'x' }),
    });
    await withPatches(patches, () => withServer(t, READER, async (base) => {
        const body = await (await fetch(`${base}/wp1`)).json();
        assert.strictEqual(body.files.html, '', 'another page\'s bytes must never be served here');
    }));
});

test('GET /:id carries the live public-share count so the header cannot claim "Personal"', async (t) => {
    const page = { ...BASE_PAGE };
    const patches = readPatches(page, {});
    patches.push([publicShareStore, 'countLiveSharesForWebpages', async () => new Map([['wp1', 2]])]);
    await withPatches(patches, () => withServer(t, OWNER, async (base) => {
        const body = await (await fetch(`${base}/wp1`)).json();
        assert.strictEqual(body.webpage.publicShareCount, 2);
    }));
});

test('a failed share count leaves publicShareCount null — unknown, never "no shares"', async (t) => {
    const page = { ...BASE_PAGE };
    const patches = readPatches(page, {});
    patches.push([publicShareStore, 'countLiveSharesForWebpages', async () => { throw new Error('db down'); }]);
    await withPatches(patches, () => withServer(t, OWNER, async (base) => {
        const body = await (await fetch(`${base}/wp1`)).json();
        assert.strictEqual(body.webpage.publicShareCount, null);
    }));
});

// ── The thumbnail ─────────────────────────────────────────────────────

test('a non-owner gets no thumbnail once the live files have moved past the pin', async (t) => {
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old', htmlSha: 'MOVED-ON' };
    const patches = readPatches(page, {
        readThumbnail: async () => Buffer.from([0xff, 0xd8, 0x01, 0x02]),
    });
    await withPatches(patches, () => withServer(t, READER, async (base) => {
        const res = await fetch(`${base}/wp1/thumbnail`);
        assert.strictEqual(res.status, 404,
            'the thumbnail is a screenshot of the LIVE page — showing it would leak unpublished work');
    }));
});

test('a non-owner still gets the thumbnail while live and published match', async (t) => {
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old' };
    const patches = readPatches(page, {
        readThumbnail: async () => Buffer.from([0xff, 0xd8, 0x01, 0x02]),
    });
    await withPatches(patches, () => withServer(t, READER, async (base) => {
        const res = await fetch(`${base}/wp1/thumbnail`);
        assert.strictEqual(res.status, 200);
    }));
});

test('the owner always gets their own thumbnail', async (t) => {
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-old', htmlSha: 'MOVED-ON' };
    const patches = readPatches(page, {
        readThumbnail: async () => Buffer.from([0xff, 0xd8, 0x01, 0x02]),
    });
    await withPatches(patches, () => withServer(t, OWNER, async (base) => {
        assert.strictEqual((await fetch(`${base}/wp1/thumbnail`)).status, 200);
    }));
});

test('a non-owner gets no thumbnail when the pin is GONE (liveMatchesPin: unknown → no image)', async (t) => {
    // The slots path already refuses a dangling pointer; the image path has to
    // refuse it too. `readThumbnail` returns bytes here on purpose: the only
    // thing that may stop them is liveMatchesPin(meta === null) → false. Flip
    // that to `true` and this is the test that goes red — without it a pruned
    // or deleted pin hands a reader a screenshot of the LIVE page.
    const page = { ...BASE_PAGE, isPublished: true, publishedVersionId: 'v-pruned' };
    const patches = readPatches(page, {
        readThumbnail: async () => Buffer.from([0xff, 0xd8, 0x01, 0x02]),
    });
    await withPatches(patches, () => withServer(t, READER, async (base) => {
        const res = await fetch(`${base}/wp1/thumbnail`);
        assert.strictEqual(res.status, 404,
            'a pointer with no version row is unknown — unknown must never widen to the live screenshot');
    }));
});
