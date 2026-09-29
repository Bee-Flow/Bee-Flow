/**
 * htmlSanitizer unit tests — the write-path defense for notebook document
 * bodies, plus the block-aware plaintext extractor the card previews use.
 *
 * Locks two things:
 *   1. Active content (script/iframe/handlers/javascript: URLs) is stripped
 *      while the markup the editor legitimately produces survives — mermaid
 *      divs carry data-type/data-code, imported images are base64 data URIs.
 *   2. htmlToPlainText emits real block boundaries: '<p>a</p><p>b</p>' must
 *      become 'a\nb', never the glued 'ab' that mangled previews.
 *
 * Run: node --test core/htmlSanitizer.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    sanitizeDocumentHtml, htmlToPlainText, sanitizePlainText, sanitizePlainTextFields,
} = require('./htmlSanitizer');

// ── sanitizeDocumentHtml ──────────────────────────────────────────
test('script tags are stripped, surrounding content kept', () => {
    const out = sanitizeDocumentHtml('<p>hi</p><script>alert(1)</script><p>bye</p>');
    assert.ok(!/script|alert/i.test(out), 'no script remnants');
    assert.match(out, /<p>hi<\/p>/);
    assert.match(out, /<p>bye<\/p>/);
});

test('event handler attributes are stripped', () => {
    const out = sanitizeDocumentHtml('<img src="x.png" onerror="alert(1)">');
    assert.ok(!/onerror/i.test(out));
});

test('javascript: URLs are stripped', () => {
    const out = sanitizeDocumentHtml('<a href="javascript:alert(1)">x</a>');
    assert.ok(!/javascript:/i.test(out));
});

test('iframe/object/embed/form/base/meta/link are all forbidden', () => {
    const out = sanitizeDocumentHtml(
        '<iframe src="https://evil"></iframe><object data="x"></object><embed src="x">' +
        '<form action="/steal"><input></form><base href="https://evil/"><meta http-equiv="refresh"><link rel="stylesheet" href="x">'
    );
    for (const tag of ['iframe', 'object', 'embed', 'form', 'base', 'meta', 'link']) {
        assert.ok(!new RegExp(`<${tag}\\b`, 'i').test(out), `<${tag}> must be stripped`);
    }
});

test('mermaid divs keep data-type/data-code, style survives', () => {
    // data-code is base64 in persisted HTML (editor's encodeForAttr) — raw
    // diagram text with `-->` would trip DOMPurify's SAFE_FOR_XML guard, and
    // rightly so; the real attribute shape must survive untouched.
    const code = Buffer.from('graph TD; A-->B').toString('base64');
    const out = sanitizeDocumentHtml(`<div data-type="mermaid-diagram" data-code="${code}" style="color: red">x</div>`);
    assert.match(out, /data-type="mermaid-diagram"/);
    assert.ok(out.includes(`data-code="${code}"`), 'base64 diagram code must survive verbatim');
    assert.match(out, /style=/);
});

test('base64 data:image src survives (imported images)', () => {
    const out = sanitizeDocumentHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
    assert.match(out, /src="data:image\/png;base64,/);
});

test('empty/nullish input → empty string', () => {
    assert.strictEqual(sanitizeDocumentHtml(''), '');
    assert.strictEqual(sanitizeDocumentHtml(null), '');
});

// ── htmlToPlainText ───────────────────────────────────────────────
test('adjacent blocks get a newline boundary, never glued', () => {
    assert.strictEqual(htmlToPlainText('<p>a</p><p>b</p>'), 'a\nb');
});

test('inline markup stays on one line', () => {
    assert.strictEqual(htmlToPlainText('<p>a <strong>b</strong> c</p>'), 'a b c');
});

test('headings, list items and table rows break lines', () => {
    assert.strictEqual(
        htmlToPlainText('<h1>T</h1><ul><li>one</li><li>two</li></ul><table><tr><td>x</td></tr></table>'),
        'T\none\ntwo\nx'
    );
});

test('source-formatting whitespace collapses; nested blocks do not double-break', () => {
    assert.strictEqual(htmlToPlainText('<div><p>a\n   b</p></div><p>c</p>'), 'a b\nc');
});

test('script/style content is ignored', () => {
    assert.strictEqual(htmlToPlainText('<p>a</p><style>.x{color:red}</style><script>let y=1</script>'), 'a');
});

test('empty input → empty string', () => {
    assert.strictEqual(htmlToPlainText(''), '');
    assert.strictEqual(htmlToPlainText('   '), '');
});

// ── sanitizePlainText — identity fields that must never carry markup ──
//
// A pentest stored `<img src=x onerror=...>` in an organisation's tagline and
// it round-tripped verbatim. React escaped it on render, so nothing executed —
// but that made every render path load-bearing, and one of them was not React:
// the invitation email interpolated the same field into an HTML document sent
// to a third party. These lock the write-path half of that fix.

test('markup is stripped, the words survive', () => {
    assert.strictEqual(sanitizePlainText('<b>Acme</b> B.V.'), 'Acme B.V.');
    assert.strictEqual(sanitizePlainText('<em>Kwaliteit</em> sinds 1994'), 'Kwaliteit sinds 1994');
});

test('the pentest payloads store as nothing dangerous', () => {
    assert.strictEqual(sanitizePlainText('<img src=x onerror="document.title=1">'), '');
    // DOMPurify drops the CONTENT of script/style, not just the tags — safer
    // than keeping the text, and worth pinning so a config change is visible.
    assert.strictEqual(sanitizePlainText('<script>alert(1)</script>'), '');
    assert.strictEqual(sanitizePlainText('<iframe src="//evil"></iframe>'), '');
});

test('ordinary text is left alone, ampersands included', () => {
    assert.strictEqual(sanitizePlainText('Ben & Jerry'), 'Ben & Jerry');
    assert.strictEqual(sanitizePlainText('plain text'), 'plain text');
    // Entity-encoding on the way out would store `&amp;` and it would render as
    // the literal five characters everywhere. Decode back to what was typed.
    assert.ok(!sanitizePlainText('A & B').includes('&amp;'));
});

test('whitespace is normalised and length is capped', () => {
    assert.strictEqual(sanitizePlainText('  spaced   out  '), 'spaced out');
    assert.strictEqual(sanitizePlainText('line\n\nbreak'), 'line break');
    assert.strictEqual(sanitizePlainText('x'.repeat(600)).length, 512);
    assert.strictEqual(sanitizePlainText('x'.repeat(600), { maxLen: 10 }).length, 10);
});

test('zero-width smuggling characters do not survive a name', () => {
    // Invisible in every UI, which is exactly why a name is a good place to
    // hide something. utils/unicodeSanitizer already knows these.
    const smuggled = `Acme\u200b\u200c\u2060 B.V.`;
    const cleaned = sanitizePlainText(smuggled);
    assert.ok(!/[\u200b\u200c\u2060]/.test(cleaned), `zero-width survived: ${JSON.stringify(cleaned)}`);
    assert.match(cleaned, /Acme/);
});

test('non-strings and absent values pass through untouched', () => {
    // Update payloads are partial: turning undefined into '' would blank a
    // column the caller never mentioned.
    assert.strictEqual(sanitizePlainText(undefined), undefined);
    assert.strictEqual(sanitizePlainText(null), null);
    assert.strictEqual(sanitizePlainText(42), 42);
    assert.strictEqual(sanitizePlainText(''), '');
});

test('sanitizePlainTextFields only touches keys that are present', () => {
    const out = sanitizePlainTextFields(
        { name: '<i>A</i>', count: 7 },
        ['name', 'tagline'],
    );
    assert.strictEqual(out.name, 'A');
    assert.strictEqual(out.count, 7, 'unlisted fields are untouched');
    assert.ok(!('tagline' in out), 'an absent field must not be invented');
});
