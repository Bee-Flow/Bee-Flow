// @typecheck
'use strict';
/**
 * core/seo/targetLocales.js: the locales of a page, a blog post and an integration page.
 *
 * Run: cd server && node --test core/seo/targetLocales.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { localesForTarget } = require('./targetLocales');

const SNAPSHOT = {
    site: { pages: [{ id: 'pg_home', slug: 'home', isHomepage: true }, { id: 'pg_plans', slug: 'plans' }] },
    pageLocaleOverrides: { pg_plans: { nl: { blocks: { b1: { title: 'Prijzen' } } } } },
    posts: { po_1: { slug: 'eu-hosting' }, po_2: { slug: 'english-only' } },
    postLocaleOverrides: { po_1: { nl: { title: 'EU-hosting' } }, po_2: { nl: { title: '  ' } } },
};
const LOCALES = ['en', 'nl'];

test('a CMS page: the default plus its real translations; the homepage by the empty slug', () => {
    assert.deepEqual(localesForTarget(SNAPSHOT, 'plans', 'en', LOCALES), ['en', 'nl']);
    assert.deepEqual(localesForTarget(SNAPSHOT, '', 'en', LOCALES), ['en']);
    assert.equal(localesForTarget(SNAPSHOT, 'nothing-here', 'en', LOCALES), null);
});

test('a blog post: translated or not, by its slug; an unknown post is null', () => {
    assert.deepEqual(localesForTarget(SNAPSHOT, 'blog/eu-hosting', 'en', LOCALES), ['en', 'nl']);
    assert.deepEqual(localesForTarget(SNAPSHOT, 'blog/english-only', 'en', LOCALES), ['en']);
    assert.equal(localesForTarget(SNAPSHOT, 'blog/unknown', 'en', LOCALES), null);
});

test('an integration page: the languages its write-up exists in; the directory in every content locale', () => {
    assert.deepEqual(localesForTarget(SNAPSHOT, 'integrations/gmail', 'en', LOCALES), ['en', 'nl']);
    assert.deepEqual(localesForTarget(SNAPSHOT, 'integrations/music-gen', 'en', LOCALES), ['en']);
    assert.deepEqual(localesForTarget(SNAPSHOT, 'integrations/directory', 'en', LOCALES), ['en', 'nl']);
});
