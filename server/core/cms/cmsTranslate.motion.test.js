// @typecheck
/**
 * Structural keys of the motion options (issue 244) must never reach the
 * translator: a "translated" poster key, fit or overlay would break the block.
 * Prose (button text, duration) stays translatable.
 *
 * Run: node --test core/cms/cmsTranslate.motion.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
const { isDeniedKey } = require('./cmsTranslate');

test('asset keys, language codes and fixed vocabularies are not translated', () => {
    for (const key of ['poster', 'captionsLang', 'fit', 'position', 'overlay', 'tilt', 'numeral', 'webmSrc', 'teaserSrc', 'overlayColor', 'repoUrl', 'gradient', 'role', 'kind']) {
        assert.strictEqual(isDeniedKey(key), true, key);
    }
});

test('the pill text and duration are prose and do translate', () => {
    for (const key of ['label', 'duration', 'windowTitle', 'prompt', 'prevLabel']) {
        assert.strictEqual(isDeniedKey(key), false, key);
    }
});
