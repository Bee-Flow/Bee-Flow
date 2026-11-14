// The App Store listing in appinfo/info.xml: a summary and a description in
// English and Dutch, in the order the schema requires, and a website link to
// the page about the connector rather than the site's homepage.
//
// Schema (https://apps.nextcloud.com/schema/apps/info.xsd): <name>, <summary>
// and <description> repeat with a `lang` attribute (default "en"), in that
// sequence; a summary holds at most 128 characters.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INFO_XML = path.join(__dirname, '..', 'appinfo', 'info.xml');
const xml = fs.readFileSync(INFO_XML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
// The listing elements sit before <version>; the variables further down have descriptions of their own.
const head = xml.slice(0, xml.indexOf('<version>'));

/** @param {string} tag @returns {{ lang: string, text: string, at: number }[]} */
function elements(tag) {
    const re = new RegExp(`<${tag}(?:\\s+lang="([a-z_]+)")?>([\\s\\S]*?)</${tag}>`, 'g');
    return [...head.matchAll(re)].map((m) => ({
        lang: m[1] || 'en',
        text: m[2].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim(),
        at: m.index,
    }));
}

test('summary and description exist in English and Dutch', () => {
    for (const tag of ['summary', 'description']) {
        const langs = elements(tag).map((e) => e.lang).sort();
        assert.deepEqual(langs, ['en', 'nl'], `<${tag}> in en and nl`);
        for (const e of elements(tag)) assert.ok(e.text.length > 0, `<${tag} lang="${e.lang}"> is not empty`);
    }
});

test('a summary fits the 128 characters of the schema', () => {
    for (const e of elements('summary')) {
        assert.ok(e.text.length <= 128, `summary ${e.lang} is ${e.text.length} characters`);
        assert.ok(!e.text.includes('<'), `summary ${e.lang} is plain text`);
    }
});

test('the elements follow the schema sequence: names, summaries, descriptions', () => {
    const last = (/** @type {string} */ tag) => Math.max(...elements(tag).map((e) => e.at));
    const first = (/** @type {string} */ tag) => Math.min(...elements(tag).map((e) => e.at));
    assert.ok(last('name') < first('summary'));
    assert.ok(last('summary') < first('description'));
});

test('the listing uses plain wording and names no price', () => {
    const text = [...elements('summary'), ...elements('description')].map((e) => e.text).join('\n');
    for (const word of ['seamless', 'powerful', 'robust', 'naadloos', 'krachtig']) {
        assert.ok(!text.toLowerCase().includes(word), `the listing does not say "${word}"`);
    }
    assert.ok(!text.includes('€') && !/\bEUR\b/.test(text), 'the listing names no price');
});

test('every link in the descriptions is https', () => {
    for (const e of elements('description')) {
        for (const m of e.text.matchAll(/\]\(([^)]+)\)/g)) {
            assert.ok(m[1].startsWith('https://'), `${e.lang}: ${m[1]}`);
        }
    }
});

test('the website link is the page about the Nextcloud connector', () => {
    const website = (xml.match(/<website>([^<]*)<\/website>/) || [])[1];
    assert.equal(website, 'https://beeflow.nl/nextcloud');
});
