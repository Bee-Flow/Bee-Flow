// @typecheck strict
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseSitemap } = require('./sitemapParse');

const BASE = 'https://example.com/sitemap.xml';

test('a urlset yields page URLs, resolved against the sitemap URL', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://example.com/a</loc><lastmod>2024-01-01</lastmod>
    <image:image><image:loc>https://example.com/img.png</image:loc></image:image></url>
  <url><loc>/b?x=1&amp;y=2</loc></url>
  <url><loc><![CDATA[https://example.com/c]]></loc></url>
  <url><loc>123</loc></url>
  <url/>
</urlset>`;
    assert.deepStrictEqual(parseSitemap(xml, BASE), {
        urls: ['https://example.com/a', 'https://example.com/b?x=1&y=2', 'https://example.com/c', 'https://example.com/123'],
        sitemaps: [],
    });
});

test('a urlset with a single url is still a list', () => {
    const xml = '<urlset><url><loc>https://example.com/only</loc></url></urlset>';
    assert.deepStrictEqual(parseSitemap(xml, BASE).urls, ['https://example.com/only']);
});

test('a sitemapindex yields nested sitemap URLs', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/s1.xml</loc></sitemap>
  <sitemap><loc> /s2.xml </loc></sitemap>
</sitemapindex>`;
    assert.deepStrictEqual(parseSitemap(xml, BASE), {
        urls: [],
        sitemaps: ['https://example.com/s1.xml', 'https://example.com/s2.xml'],
    });
    assert.deepStrictEqual(
        parseSitemap('<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>', BASE).sitemaps,
        ['https://example.com/s1.xml'],
    );
});

test('other documents yield nothing and malformed XML throws', () => {
    assert.deepStrictEqual(parseSitemap('<urlset/>', BASE), { urls: [], sitemaps: [] });
    assert.deepStrictEqual(parseSitemap('<html><body>no</body></html>', BASE), { urls: [], sitemaps: [] });
    assert.throws(() => parseSitemap('<urlset><url><loc>x</url></urlset>', BASE));
    assert.throws(() => parseSitemap('not xml', BASE));
});
