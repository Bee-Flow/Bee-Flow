const { test } = require('node:test');
const assert = require('node:assert');
const { htmlAttributeText, outboundScanText } = require('./emailStep');
const emailSend = require('../../services/email/send');

test('BFSF-461: mailto/tel targets, title and alt reach the scan text', () => {
    const html = emailSend.sanitizeHtml('<p>See <a href="mailto:jan.devries@klant.nl?subject=hi" title="Jan de Vries">the contact</a>, '
        + '<a href="tel:+31612345678">call</a> <img alt="J&amp;J Smit" src="x.png"></p>');
    const text = emailSend.htmlToText(html);
    assert.ok(!text.includes('jan.devries@klant.nl'), 'the plain-text rendering drops it');
    const scan = outboundScanText({ format: 'html', textBody: text, htmlBody: html });
    assert.ok(scan.includes('jan.devries@klant.nl'));
    assert.ok(!scan.includes('mailto:') && !scan.includes('subject=hi'));
    assert.ok(scan.includes('Jan de Vries'));
    assert.ok(scan.includes('+31612345678'));
    assert.ok(scan.includes('J&J Smit'));
});

test('plain web links and non-html formats add nothing', () => {
    assert.equal(htmlAttributeText('<a href="https://example.com/a">x</a>'), '');
    assert.equal(outboundScanText({ format: 'text', textBody: 'hello', htmlBody: '<a title="Jan">x</a>' }), 'hello');
    assert.equal(outboundScanText({ format: 'html', textBody: 'hi', htmlBody: '<p>hi</p>' }), 'hi');
});

test('BFSF-461: personal data in the query string of a web link or image source reaches the scan, the host and path do not', () => {
    const html = '<p><a href="https://crm.example/contact?email=jan.devries@klant.nl&amp;name=Jan%20de%20Vries#ref=Q-17">crm</a>'
        + '<img src="https://t.example/p.png?to=jan%40klant.nl"></p>';
    const scan = htmlAttributeText(html);
    assert.ok(scan.includes('jan.devries@klant.nl'));
    assert.ok(scan.includes('Jan de Vries'));
    assert.ok(scan.includes('jan@klant.nl'));
    assert.ok(scan.includes('Q-17'));
    assert.ok(!scan.includes('crm.example') && !scan.includes('t.example') && !scan.includes('/contact'));
});

test('BFSF-461: data:, cid: and relative sources, and plain anchors, add nothing', () => {
    const html = '<img src="data:image/png;base64,AAAA?x=1"><img src="cid:logo@mail"><img src="logo.png?v=3"><a href="https://example.com/page#top">x</a>';
    assert.equal(htmlAttributeText(html), '');
});
