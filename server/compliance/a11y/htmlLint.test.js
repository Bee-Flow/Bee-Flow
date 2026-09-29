/**
 * htmlLint — one fixture per rule, a clean page, the fragment posture and
 * the e-mail scrub. Pure function, no db, no stubs.
 *
 * Run: cd server && node --test --test-force-exit compliance/a11y/htmlLint.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { lint, RULES, VERSION } = require('./htmlLint');

const CLEAN = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Toegankelijke pagina</title>
</head>
<body>
  <header><h1>Welkom</h1></header>
  <nav><a href="/over">Over ons</a> <a href="/contact"><img src="mail.svg" alt="Contact"></a></nav>
  <main>
    <h2>Formulier</h2>
    <img src="logo.png" alt="Bee Flow logo">
    <img src="divider.png" alt="">
    <svg role="presentation"><path d="M0 0"/></svg>
    <form>
      <label for="name">Naam</label><input id="name" type="text">
      <label>E-mail <input type="email"></label>
      <input type="search" aria-label="Zoeken">
      <select id="lang" aria-labelledby="lang-label"><option>nl</option></select>
      <span id="lang-label">Taal</span>
      <textarea title="Opmerking"></textarea>
      <input type="hidden" value="x">
      <input type="submit" value="Verstuur">
      <button type="button">Annuleer</button>
      <button aria-label="Sluiten"><svg><path d="M0 0"/></svg></button>
    </form>
    <h3>Tabel</h3>
    <table><tr><th>Kop</th><th>Waarde</th></tr><tr><td>a</td><td>1</td></tr></table>
    <iframe title="Kaart" src="https://maps.example/embed"></iframe>
    <video src="v.mp4" controls></video>
  </main>
</body>
</html>`;

function rule(result, name) {
    return [...result.errors, ...result.warnings].find(r => r.rule === name) || null;
}

test('module shape: RULES cover the catalogue and VERSION is a semver', () => {
    const expected = [
        'html-lang', 'img-alt', 'control-label', 'link-name', 'button-name', 'page-title', 'iframe-title',
        'heading-order', 'duplicate-id', 'tabindex-positive', 'meta-refresh', 'viewport-zoom', 'media-autoplay',
        'table-headers', 'link-text-generic', 'svg-alt',
    ];
    for (const r of expected) assert.ok(RULES[r], `rule ${r} is defined`);
    for (const [name, def] of Object.entries(RULES)) {
        assert.ok(['error', 'warning'].includes(def.level), `${name} has a level`);
        assert.match(def.wcag, /^\d\.\d\.\d/, `${name} names a WCAG criterion`);
    }
    const errorRules = Object.entries(RULES).filter(([, d]) => d.level === 'error').map(([n]) => n).sort();
    assert.deepEqual(errorRules, ['button-name', 'control-label', 'html-lang', 'iframe-title', 'img-alt', 'link-name', 'page-title']);
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('a clean page has no errors and no warnings, and every rule was checked', () => {
    const r = lint(CLEAN);
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
    assert.equal(r.fragment, false);
    assert.equal(r.lang, 'nl');
    assert.equal(r.version, VERSION);
    assert.deepEqual(r.rules_skipped, []);
    for (const name of Object.keys(RULES)) assert.ok(r.rules_checked.includes(name), `${name} checked`);
});

test('non-string / empty input is a fragment with nothing to report', () => {
    for (const input of [null, undefined, 42, '']) {
        const r = lint(input);
        assert.deepEqual(r.errors, []);
        assert.equal(r.fragment, true);
    }
});

// ── error rules ─────────────────────────────────────────────────────────────

test('html-lang: missing or malformed lang on <html> is an error; a valid tag passes', () => {
    const missing = lint('<html><head><title>t</title></head><body></body></html>');
    assert.equal(rule(missing, 'html-lang').count, 1);
    assert.equal(missing.lang, null);

    const invalid = lint('<html lang="dutch language"><head><title>t</title></head><body></body></html>');
    assert.equal(rule(invalid, 'html-lang').count, 1);
    assert.match(rule(invalid, 'html-lang').samples[0], /invalid lang/);

    const ok = lint('<html lang="en-GB"><head><title>t</title></head><body></body></html>');
    assert.equal(rule(ok, 'html-lang'), null);
    assert.equal(ok.lang, 'en-GB');
});

test('page-title: absent or empty <title> is an error', () => {
    const none = lint('<html lang="en"><head></head><body><p>x</p></body></html>');
    assert.equal(rule(none, 'page-title').count, 1);
    const empty = lint('<html lang="en"><head><title>   </title></head><body></body></html>');
    assert.equal(rule(empty, 'page-title').count, 1);
});

test('img-alt: informative images without alt are errors; decorative markers are exempt', () => {
    const r = lint(`<div>
        <img src="a.png">
        <img src="b.png">
        <img src="c.png" alt="">
        <img src="d.png" role="presentation">
        <img src="e.png" aria-hidden="true">
        <img src="f.png" aria-label="Chart of sales">
        <img src="g.png" aria-labelledby="cap"><p id="cap">Caption</p>
    </div>`);
    const f = rule(r, 'img-alt');
    assert.equal(f.count, 2);
    assert.equal(f.wcag, '1.1.1');
    assert.equal(f.samples.length, 2);
    assert.match(f.samples[0], /a\.png/);
});

test('svg-alt: an inline svg without a name warns unless it sits inside a named control', () => {
    const r = lint(`<div>
        <svg><path d="M0 0"/></svg>
        <svg><title>Named</title></svg>
        <svg aria-hidden="true"></svg>
        <a href="/x" aria-label="Home"><svg></svg></a>
        <button><svg></svg></button>
    </div>`);
    const f = rule(r, 'svg-alt');
    assert.equal(f.count, 2, 'the bare svg and the one in the unnamed button');
    assert.ok(r.warnings.some(w => w.rule === 'svg-alt'), 'svg-alt is a warning, not an error');
});

test('control-label: every labelling technique counts; hidden/submit/button/image inputs are skipped', () => {
    const r = lint(`<form>
        <input type="text" id="unlabelled">
        <select><option>a</option></select>
        <textarea></textarea>
        <label for="ok1">One</label><input id="ok1">
        <label>Two <input id="ok2"></label>
        <input id="ok3" aria-label="Three">
        <span id="l4">Four</span><input id="ok4" aria-labelledby="l4">
        <input id="ok5" title="Five">
        <input type="hidden">
        <input type="submit" value="Go">
        <input type="button" value="Go">
        <input type="image" src="go.png" alt="Go">
        <input type="reset">
        <input type="text" aria-hidden="true">
        <label for="empty"></label><input id="empty" type="text">
    </form>`);
    const f = rule(r, 'control-label');
    assert.equal(f.count, 4, 'unlabelled input, bare select, bare textarea, input with an empty <label for>');
    assert.equal(f.wcag, '1.3.1/3.3.2');
});

test('link-name: links with no accessible name are errors; image alt, aria, svg title and title count as names', () => {
    const r = lint(`<nav>
        <a href="/1"></a>
        <a href="/2"><img src="i.png"></a>
        <a href="/3"><img src="i.png" alt="Three"></a>
        <a href="/4" aria-label="Four"></a>
        <span id="five">Five</span><a href="/5" aria-labelledby="five"></a>
        <a href="/6"><svg><title>Six</title></svg></a>
        <a href="/7" title="Seven"></a>
        <a href="/8" aria-hidden="true"></a>
        <a>no href, not a link</a>
    </nav>`);
    const f = rule(r, 'link-name');
    assert.equal(f.count, 2);
    assert.equal(f.wcag, '2.4.4');
});

test('link-text-generic: "click here" style link text warns, with Dutch variants; real text does not', () => {
    const r = lint(`<p>
        <a href="/a">Click here</a>
        <a href="/b">lees meer</a>
        <a href="/c">Hier</a>
        <a href="/d">Read more »</a>
        <a href="/e">Bekijk hier de voorwaarden</a>
        <a href="/f">Hiërarchie</a>
        <a href="/g">Lees meer over onze prijzen</a>
    </p>`);
    const f = rule(r, 'link-text-generic');
    assert.equal(f.count, 4);
    assert.ok(r.warnings.some(w => w.rule === 'link-text-generic'));
    assert.equal(rule(r, 'link-name'), null);
});

test('button-name: buttons and role=button without a name are errors; input[type=button|image] need a value/alt', () => {
    const r = lint(`<div>
        <button></button>
        <div role="button"></div>
        <button aria-label="Named"></button>
        <button>Text</button>
        <input type="button">
        <input type="image" src="x.png">
        <input type="image" src="y.png" alt="Search">
        <input type="button" value="Go">
        <input type="submit">
        <button aria-hidden="true"></button>
    </div>`);
    const f = rule(r, 'button-name');
    assert.equal(f.count, 4);
    assert.equal(f.wcag, '4.1.2');
});

test('iframe-title: an iframe without title/aria-label is an error', () => {
    const r = lint(`<div>
        <iframe src="a"></iframe>
        <iframe src="b" title="Map"></iframe>
        <iframe src="c" aria-label="Video"></iframe>
        <iframe src="d" aria-hidden="true"></iframe>
    </div>`);
    assert.equal(rule(r, 'iframe-title').count, 1);
});

// ── warning rules ───────────────────────────────────────────────────────────

test('heading-order: a skipped level and multiple h1s warn; a proper outline does not', () => {
    const skip = lint('<h1>A</h1><h3>B</h3><h2>C</h2><h4>D</h4>');
    const f = rule(skip, 'heading-order');
    assert.equal(f.count, 2, 'h1→h3 and h2→h4');
    assert.match(f.samples[0], /h1 → h3/);

    const twoH1 = lint('<h1>A</h1><h2>B</h2><h1>C</h1>');
    assert.equal(rule(twoH1, 'heading-order').count, 1);
    assert.match(rule(twoH1, 'heading-order').samples[0], /2 <h1> elements/);

    const fine = lint('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>');
    assert.equal(rule(fine, 'heading-order'), null);
});

test('duplicate-id: repeated ids warn once per id with the multiplicity', () => {
    const r = lint('<div id="x"></div><div id="x"></div><div id="x"></div><div id="y"></div>');
    const f = rule(r, 'duplicate-id');
    assert.equal(f.count, 1);
    assert.match(f.samples[0], /id="x" ×3/);
    assert.equal(f.wcag, '4.1.1');
});

test('tabindex-positive: only positive values warn', () => {
    const r = lint('<a href="/" tabindex="3">a</a><div tabindex="0"></div><div tabindex="-1"></div><div tabindex="abc"></div>');
    assert.equal(rule(r, 'tabindex-positive').count, 1);
});

test('meta-refresh: a timed refresh warns; an instant (0) redirect does not', () => {
    const timed = lint('<html lang="en"><head><title>t</title><meta http-equiv="refresh" content="5; url=/x"></head><body></body></html>');
    assert.equal(rule(timed, 'meta-refresh').count, 1);
    const instant = lint('<html lang="en"><head><title>t</title><meta http-equiv="Refresh" content="0; url=/x"></head><body></body></html>');
    assert.equal(rule(instant, 'meta-refresh'), null);
    const garbage = lint('<html lang="en"><head><title>t</title><meta http-equiv="refresh" content="soon"></head><body></body></html>');
    assert.equal(rule(garbage, 'meta-refresh').count, 1);
});

test('viewport-zoom: user-scalable=no or a maximum-scale below 2 warns', () => {
    const noScale = lint('<meta name="viewport" content="width=device-width, user-scalable=no">');
    assert.equal(rule(noScale, 'viewport-zoom').count, 1);
    const maxScale = lint('<meta name="viewport" content="width=device-width, maximum-scale=1.0">');
    assert.equal(rule(maxScale, 'viewport-zoom').count, 1);
    const fine = lint('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">');
    assert.equal(rule(fine, 'viewport-zoom'), null);
});

test('media-autoplay: autoplaying audio/video warns unless the video is muted', () => {
    const r = lint('<video src="a" autoplay></video><audio src="b" autoplay></audio><video src="c" autoplay muted></video><video src="d"></video>');
    assert.equal(rule(r, 'media-autoplay').count, 2);
    assert.equal(rule(r, 'media-autoplay').wcag, '1.4.2');
});

test('table-headers: a multi-row data table without <th> warns; layout, presentational and headed tables do not', () => {
    const r = lint(`
        <table><tr><td>a</td></tr><tr><td>b</td></tr></table>
        <table><tr><td>only one row</td></tr></table>
        <table role="presentation"><tr><td>a</td></tr><tr><td>b</td></tr></table>
        <table><tr><th>h</th></tr><tr><td>b</td></tr></table>
    `);
    assert.equal(rule(r, 'table-headers').count, 1);
});

// ── fragments, samples and scrubbing ────────────────────────────────────────

test('fragment: html-lang and page-title are skipped (not passed) and opts.lang is recorded', () => {
    const r = lint('<h1>Hoi</h1><p>Body only</p>', { lang: 'nl' });
    assert.equal(r.fragment, true);
    assert.equal(r.lang, 'nl');
    assert.deepEqual(r.rules_skipped.map(s => s.rule).sort(), ['html-lang', 'page-title']);
    assert.ok(!r.rules_checked.includes('html-lang'));
    assert.ok(!r.rules_checked.includes('page-title'));
    assert.deepEqual(r.errors, []);
    // a junk opts.lang is not recorded as a language
    assert.equal(lint('<p>x</p>', { lang: 'not a tag' }).lang, null);
});

test('samples are capped at 10 per rule while the count keeps going', () => {
    const imgs = Array.from({ length: 25 }, (_, i) => `<img src="${i}.png">`).join('');
    const f = rule(lint(imgs), 'img-alt');
    assert.equal(f.count, 25);
    assert.equal(f.samples.length, 10);
});

test('samples never carry an e-mail address (mailto links, footer addresses)', () => {
    const r = lint(`<footer>
        <a href="mailto:jan.jansen@example.org"></a>
        <img src="x.png" title="mail piet@example.com now">
        <a href="/contact">Click here</a>
    </footer>`);
    const blob = JSON.stringify(r);
    assert.ok(!/@/.test(blob), `no e-mail in lint output: ${blob}`);
    assert.match(JSON.stringify(rule(r, 'link-name').samples), /\[email\]/);
});

test('long snippets are truncated', () => {
    const r = lint(`<img src="${'x'.repeat(500)}.png">`);
    const s = rule(r, 'img-alt').samples[0];
    assert.ok(s.length <= 160, `snippet length ${s.length}`);
    assert.ok(s.endsWith('…'));
});

test('findings are sorted by count descending, then rule name', () => {
    const r = lint('<img src="a"><img src="b"><button></button><a href="/"></a><a href="/x"></a>');
    assert.deepEqual(r.errors.map(e => e.rule), ['img-alt', 'link-name', 'button-name']);
});
