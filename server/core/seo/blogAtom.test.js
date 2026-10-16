'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAtomFeed, atomPath } = require('./blogAtom');
const { buildBlogHead } = require('./blog');

const ORIGIN = 'https://site.test';
const post = {
    slug: 'hello-world', title: 'Fish & <Chips>\u0001', excerpt: 'An "excerpt" & more',
    body: 'Text <b>raw</b> [x](javascript:alert(1))', coverImage: 'cms/1700-cover.jpg', coverAlt: 'Cover "art"',
    authorName: 'Ann <Writer>', tags: [{ slug: 'p', label: 'R&D' }], publishedAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
};

test('Atom feed: well-formed shape, escaped text, absolute links, locale paths', () => {
    const xml = buildAtomFeed([post], { origin: ORIGIN, siteName: 'Acme', title: 'Blog', description: 'News & more', locale: 'nl', defaultLocale: 'en', lastBuildDate: '2026-10-03T00:00:00Z' });
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="nl">'));
    assert.match(xml, /<title>Fish &amp; &lt;Chips&gt;<\/title>/, 'escaped, control character stripped');
    assert.match(xml, /<id>https:\/\/site.test\/nl\/blog\/hello-world<\/id>/);
    assert.match(xml, /<link rel="self" type="application\/atom\+xml" href="https:\/\/site.test\/nl\/blog\/atom.xml"\/>/);
    assert.match(xml, /<updated>2026-10-03T00:00:00.000Z<\/updated>/);
    assert.match(xml, /<author><name>Ann &lt;Writer&gt;<\/name><\/author>/);
    assert.match(xml, /<category term="R&amp;D"\/>/);
    assert.match(xml, /<subtitle>News &amp; more<\/subtitle>/);
    assert.ok(!/<b>raw|javascript:|<script/i.test(xml), 'the body never reaches the feed as live markup or a javascript: link');
    assert.equal(atomPath('en', 'en'), '/blog/atom.xml');
});

test('Atom feed with no posts still has the required feed-level elements', () => {
    const xml = buildAtomFeed([], { origin: ORIGIN, siteName: 'Acme', title: 'Blog', description: '', locale: 'en', defaultLocale: 'en' });
    assert.match(xml, /<id>https:\/\/site.test\/blog\/atom.xml<\/id>/);
    assert.match(xml, /<updated>1970-01-01T00:00:00.000Z<\/updated>/);
    assert.ok(!xml.includes('<entry>'));
});

test('blog index head advertises the Atom feed next to RSS', () => {
    const eff = {
        design: {}, page: { slug: 'blog', title: 'Blog', seo: {}, blocks: [] },
        blog: { view: 'index', locale: 'en', defaultLocale: 'en', basePath: '/blog', title: 'Blog', description: '', labels: {}, posts: [], page: 1, pageCount: 1, total: 0, tag: null, tags: [] },
    };
    const head = buildBlogHead({ origin: ORIGIN, eff, locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
    assert.match(head, /type="application\/atom\+xml"[^>]*href="https:\/\/site.test\/blog\/atom.xml"/);
});
