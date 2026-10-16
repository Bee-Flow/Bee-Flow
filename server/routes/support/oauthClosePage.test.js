/**
 * The OAuth close page (routes/support/oauthClosePage.js): what it shows and
 * what it hands the opener, for ordinary values and for values that contain
 * markup or script-significant characters.
 *
 * Run: cd server && node --test routes/support/oauthClosePage.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { oauthClosePage, serviceEmailClosePage } = require('./oauthClosePage');

/** The string the page's script posts to the opener, read back as the browser would. */
function postedPayload(html) {
    const m = /postMessage\(("(?:[^"\\]|\\.)*"),'\*'\)/.exec(html);
    assert.ok(m, 'the page posts a string literal to the opener');
    return JSON.parse(JSON.parse(m[1]));
}

const paragraph = (html) => /<p>([\s\S]*)<\/p>/.exec(html)[1];

test('a successful connect: the fixed text, and the opener learns ok + the address', () => {
    const html = serviceEmailClosePage(true, 'ops@example.com');
    assert.strictEqual(paragraph(html), 'Service email connected. You can close this window.');
    assert.deepStrictEqual(postedPayload(html), { type: 'service-email-oauth', ok: true, message: 'ops@example.com' });
    assert.match(html, /<title>Service email connected<\/title>/);
});

test('an ordinary failure reads as before', () => {
    const html = oauthClosePage(false, 'access_denied');
    assert.strictEqual(paragraph(html), 'Connection failed: access_denied');
    assert.deepStrictEqual(postedPayload(html), { type: 'support-mailbox-oauth', ok: false, message: 'access_denied' });
    assert.match(html, /<title>Mailbox connected<\/title>/);
});

test('markup in a value is shown as text, not parsed', () => {
    const value = '<b onclick="x">bold</b> & \'quoted\'';
    for (const page of [oauthClosePage, serviceEmailClosePage]) {
        const html = page(false, value);
        assert.strictEqual(paragraph(html),
            'Connection failed: &lt;b onclick=&quot;x&quot;&gt;bold&lt;/b&gt; &amp; &#39;quoted&#39;');
        assert.strictEqual(postedPayload(html).message, value, 'the opener still gets the value unchanged');
    }
});

test('the value in the script holds no character that could end the block or break the literal', () => {
    const value = `</script><script>1</script> & ${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)} >`;
    for (const page of [oauthClosePage, serviceEmailClosePage]) {
        const html = page(false, value);
        const literal = /postMessage\(("(?:[^"\\]|\\.)*"),'\*'\)/.exec(html)[1];
        assert.doesNotMatch(literal, /[<>&\u2028\u2029]/);
        assert.strictEqual(html.split('</script>').length, 2, 'exactly one closing tag: the page\'s own');
        assert.strictEqual(postedPayload(html).message, value);
    }
});

test('the shown text is still capped at 200 characters of the value', () => {
    const html = oauthClosePage(false, 'x'.repeat(500));
    assert.strictEqual(paragraph(html), `Connection failed: ${'x'.repeat(200)}`);
});
