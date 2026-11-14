// @typecheck strict
'use strict';

/**
 * webpage_file_write as the builder runs it: the store and the thumbnail
 * renderer are replaced, the doc tool and the write path are the real ones.
 */

const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const webpageStore = require('../stores/webpageStore');
const thumbnails = require('../core/webpages/webpageThumbnailGenerator');

/** @type {Array<{ file: string, content: unknown }>} */
const writes = [];
mock.method(webpageStore, 'getWebpage', async () => ({ id: 'w1', framework: 'vanilla' }));
mock.method(webpageStore, 'writeSlot', async (/** @type {string} */ _userId, /** @type {string} */ _webpageId, /** @type {string} */ file, /** @type {unknown} */ content) => {
    writes.push({ file, content });
});
mock.method(thumbnails, 'scheduleThumbnail', () => {});

const { executeBuilderTool } = require('./webpageBuilderTools');

beforeEach(() => { writes.length = 0; });

test('webpage_file_write without content writes an empty file and answers', async () => {
    const out = await executeBuilderTool('webpage_file_write', { webpageId: 'w1', file: 'css' }, { userId: 'u1' });
    assert.deepEqual(writes, [{ file: 'css', content: '' }]);
    assert.equal(out.result.error, undefined);
    assert.equal(out.webpageUpdate?.content, '');
});

test('webpage_file_write stores the content it was given', async () => {
    const out = await executeBuilderTool('webpage_file_write', { webpageId: 'w1', file: 'css', content: 'body { color: red }' }, { userId: 'u1' });
    assert.deepEqual(writes, [{ file: 'css', content: 'body { color: red }' }]);
    assert.equal(out.webpageUpdate?.content, 'body { color: red }');
});
