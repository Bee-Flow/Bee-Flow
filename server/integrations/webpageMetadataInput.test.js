// @typecheck
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeMetadata, sanitizeIcon, countLines, slotTooLarge, MAX_SLOT_CHARS } = require('./webpageMetadataInput');

test('an emoji is kept, extra text after it is trimmed away', () => {
    assert.equal(sanitizeIcon('📊'), '📊');
    assert.equal(sanitizeIcon('📊📊'), '📊');
    assert.equal(sanitizeIcon('📊 Dashboard'), '📊');
    assert.equal(sanitizeIcon('👩‍💻'), '👩‍💻');
});

test('text that is not an emoji is rejected with a warning, not cut down to one letter', () => {
    assert.equal(sanitizeIcon('not an emoji <script>'), '');
    const { updates, warnings } = sanitizeMetadata({ icon: 'not an emoji <script>' });
    assert.deepEqual(updates, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^icon was not applied/);
    assert.ok(!warnings[0].includes('script'), 'the rejected value is not echoed back');
});

test('an invalid accent_color is reported, the valid fields still apply', () => {
    const { updates, warnings } = sanitizeMetadata({ icon: '🍰', accent_color: 'red', tagline: ' Fresh bread ' });
    assert.deepEqual(updates, { icon: '🍰', tagline: 'Fresh bread' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /accent_color/);
});

test('a long tagline is shortened and says so', () => {
    const { updates, warnings } = sanitizeMetadata({ tagline: 'x'.repeat(100) });
    assert.equal(updates.tagline.length, 80);
    assert.match(warnings[0], /shortened/);
});

test('fields that were not given produce no warning', () => {
    assert.deepEqual(sanitizeMetadata({ accent_color: '#00a86b' }), { updates: { accentColor: '#00a86b' }, warnings: [] });
});

test('countLines', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\nb\nc'), 3);
});

test('slotTooLarge refuses above the cap only', () => {
    assert.equal(slotTooLarge('x'.repeat(MAX_SLOT_CHARS)), null);
    assert.match(slotTooLarge('x'.repeat(MAX_SLOT_CHARS + 1)).error, /too large/);
    assert.equal(slotTooLarge(undefined), null);
});
