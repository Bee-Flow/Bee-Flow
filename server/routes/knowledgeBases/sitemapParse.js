// @typecheck
'use strict';

const { XMLParser, XMLValidator } = require('fast-xml-parser');

// Values stay strings (a numeric-looking <loc> must not become a Number) and
// <url> / <sitemap> are always arrays, also when the file holds a single one.
const parser = new XMLParser({
    parseTagValue: false,
    isArray: (name) => name === 'url' || name === 'sitemap',
});

function firstLoc(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const loc = Array.isArray(entry.loc) ? entry.loc[0] : entry.loc;
    return typeof loc === 'string' && loc ? loc : null;
}

/**
 * Pulls the page URLs (<urlset>) and nested sitemap URLs (<sitemapindex>) out
 * of a sitemap document, resolved against the sitemap's own URL. Malformed XML
 * throws.
 */
function parseSitemap(xml, sitemapBaseUrl) {
    const valid = XMLValidator.validate(xml);
    if (valid !== true) throw new Error(`Invalid sitemap XML: ${valid.err.msg}`);
    const result = parser.parse(xml) || {};
    const urls = [];
    const sitemaps = [];
    if (result.urlset && Array.isArray(result.urlset.url)) {
        for (const u of result.urlset.url) {
            const loc = firstLoc(u);
            if (loc) urls.push(new URL(loc, sitemapBaseUrl).href);
        }
    }
    if (result.sitemapindex && Array.isArray(result.sitemapindex.sitemap)) {
        for (const sm of result.sitemapindex.sitemap) {
            const loc = firstLoc(sm);
            if (loc) sitemaps.push(new URL(loc, sitemapBaseUrl).href);
        }
    }
    return { urls, sitemaps };
}

module.exports = { parseSitemap };
