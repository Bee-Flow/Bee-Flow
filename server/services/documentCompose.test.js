/**
 * The composer is the only thing standing between AI-authored (and then
 * hand-edited) markup and a real Chromium running ON THE SERVER. These tests
 * are therefore mostly about what must NOT come out the other end.
 *
 * DB-free and browser-free: composeDocument is pure, and the assertions parse
 * the result with jsdom rather than grepping the string. That distinction is
 * the point of the `</style>` case — the attack text is still *present* in the
 * output and still completely inert, so a substring assertion would report a
 * failure that does not exist, and a different one would pass while the page
 * was owned.
 */

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const {
    composeDocument,
    sanitizeDocumentBody,
    sanitizeCssText,
} = require('./documentCompose');

/** Parse a composed document and RUN whatever scripts survived. */
function parseAndRun(html) {
    return new JSDOM(html, { runScripts: 'dangerously' });
}

// ── Body sanitising ──────────────────────────────────────────────────

test('sanitizeDocumentBody removes everything that executes or embeds', () => {
    const out = sanitizeDocumentBody(`
        <h1 onclick="alert(1)">Factuur</h1>
        <script>alert(1)</script>
        <iframe src="https://evil.test"></iframe>
        <object data="https://evil.test/x.swf"></object>
        <form action="https://evil.test"><input name="card"></form>
        <style>body{color:red}</style>
    `);
    assert.ok(!/<script/i.test(out), 'no script');
    assert.ok(!/onclick/i.test(out), 'no event handler');
    assert.ok(!/<iframe|<object|<form|<input/i.test(out), 'no embed/collect element');
    assert.ok(!/<style/i.test(out), 'no style element — the stylesheet has its own slot');
    assert.match(out, /Factuur/, 'the actual content survives');
});

test('sanitizeDocumentBody strips remote loads but keeps data: and <a href>', () => {
    const out = sanitizeDocumentBody(
        '<img src="https://evil.test/pixel.gif">'
        + '<img src="data:image/png;base64,iVBOR">'
        + '<a href="https://example.com/invoice">terms</a>',
    );
    assert.ok(!/evil\.test/.test(out), 'the renderer must not fetch a remote image');
    assert.match(out, /data:image\/png/, 'an embedded logo still works');
    // A link fetches nothing until a person clicks it, and on paper it is text.
    assert.match(out, /example\.com\/invoice/, 'an ordinary link is left alone');
});

test('sanitizeDocumentBody cleans url() out of a surviving style attribute', () => {
    const out = sanitizeDocumentBody('<div style="background:url(https://evil.test/t.png);color:#333">x</div>');
    assert.ok(!/evil\.test/.test(out), 'no remote fetch via inline CSS');
    assert.match(out, /color:#333/, 'the harmless half of the declaration survives');
});

test('sanitizeDocumentBody passes through an ordinary invoice table untouched in substance', () => {
    const markup = '<table class="lines"><thead><tr><th>Omschrijving</th><th>Bedrag</th></tr></thead>'
        + '<tbody><tr><td>Levering staal</td><td>€ 1.240,00</td></tr></tbody></table>';
    const out = sanitizeDocumentBody(markup);
    assert.match(out, /class="lines"/, 'classes survive — they are what the stylesheet targets');
    assert.match(out, /Levering staal/);
    assert.match(out, /€ 1\.240,00/);
    assert.match(out, /<thead>/, 'thead survives — it is what repeats across pages');
});

// ── CSS sanitising ───────────────────────────────────────────────────

test('sanitizeCssText drops remote fetches and keeps the document geometry', () => {
    const out = sanitizeCssText(`
        @import url('https://fonts.googleapis.com/css?family=Inter');
        @page { size: A4; margin: 18mm 16mm; }
        .logo { background: url(https://evil.test/track.png); }
        .ok { background: url(data:image/svg+xml;base64,PHN2Zz4=); }
    `);
    assert.ok(!/@import/i.test(out), '@import is a remote fetch by another name');
    assert.ok(!/evil\.test/.test(out), 'no remote url()');
    assert.match(out, /@page \{ size: A4/, '@page survives — the document owns its paper');
    assert.match(out, /data:image\/svg/, 'an embedded asset still works');
});

test('sanitizeCssText defuses the legacy script-in-CSS vectors', () => {
    const out = sanitizeCssText('.a{width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(y.xml)}');
    assert.ok(!/expression\s*\(/i.test(out));
    assert.ok(!/\bbehaviou?r\s*:/i.test(out));
    assert.ok(!/-moz-binding\s*:/i.test(out));
});

// ── Compose ──────────────────────────────────────────────────────────

test('a stylesheet cannot close its own <style> block and open a script', () => {
    // The ONE escape hatch for CSS: the HTML parser ends <style> at the literal
    // `</style`, so an un-defanged sheet could open a real <script> after it.
    const html = composeDocument({
        bodyHtml: '<p>hi</p>',
        css: '.a{color:red} </style><script>window.__PWNED = 1</script><style>',
        name: 'Factuur',
    }, { mode: 'print' });

    const dom = parseAndRun(html);
    try {
        assert.strictEqual(dom.window.document.querySelectorAll('script').length, 0,
            'no script ELEMENT exists after real HTML parsing');
        assert.strictEqual(dom.window.__PWNED, undefined, 'nothing executed');
    } finally {
        dom.window.close();
    }
});

test('print mode carries no script at all; preview mode carries the edit bridge', () => {
    const doc = { bodyHtml: '<p>hi</p>', css: '', name: 'x' };

    const print = parseAndRun(composeDocument(doc, { mode: 'print' }));
    try {
        assert.strictEqual(print.window.document.querySelectorAll('script').length, 0,
            'the PDF render must see exactly the stored markup and nothing else');
    } finally { print.window.close(); }

    const preview = composeDocument(doc, { mode: 'preview' });
    assert.match(preview, /__beeflowDocDirty/, 'the editor preview relays edits to the parent');
    assert.match(preview, /contenteditable/, 'the editor preview can be switched into editing');
});

test('the edit bridge lives in <head>, so body.innerHTML round-trips exactly', () => {
    // Load-bearing: what the bridge posts up IS body.innerHTML, and that is what
    // gets stored. Anything the bridge left in <body> would be saved into the
    // document and re-injected on the next load, compounding every time.
    const body = '<h1>Factuur</h1><table class="lines"><tr><td>x</td></tr></table>';
    const dom = parseAndRun(composeDocument({ bodyHtml: body, css: '', name: 'x' }, { mode: 'preview' }));
    try {
        const d = dom.window.document;
        assert.strictEqual(d.body.querySelectorAll('script').length, 0, 'no script inside <body>');
        assert.ok(d.head.querySelector('script'), 'the bridge is in <head>');
        assert.match(d.body.innerHTML.trim(), /^<h1>Factuur<\/h1>/, 'the body is the stored markup');
    } finally { dom.window.close(); }
});

test('the base stylesheet comes first, so the document can override it', () => {
    const html = composeDocument({ bodyHtml: '<p>x</p>', css: '@page { margin: 0; }', name: 'x' });
    const basePos = html.indexOf('@page { size: A4; margin: 18mm 16mm; }');
    const authorPos = html.indexOf('@page { margin: 0; }');
    assert.ok(basePos > -1, 'the base sheet is emitted');
    assert.ok(authorPos > basePos, 'the author sheet comes after, so a bleeding header can ask for margin:0');
});

test('the document name is escaped into <title> rather than interpolated', () => {
    const dom = parseAndRun(composeDocument({ bodyHtml: '<p>x</p>', css: '', name: 'A <script>alert(1)</script> B' }));
    try {
        assert.strictEqual(dom.window.document.querySelectorAll('script').length, 0);
        assert.match(dom.window.document.title, /A <script>alert\(1\)<\/script> B/,
            'the name is shown as TEXT, entities decoded by the parser');
    } finally { dom.window.close(); }
});

test('an empty document still composes into a valid page', () => {
    const dom = parseAndRun(composeDocument({}, { mode: 'print' }));
    try {
        assert.ok(dom.window.document.body, 'there is a body');
        assert.strictEqual(dom.window.document.body.innerHTML.trim(), '');
    } finally { dom.window.close(); }
});

// ── The house-style layer ────────────────────────────────────────────

test('the three stylesheets cascade base → house → document', () => {
    // The order IS the opt-out mechanism: a document that wants its own accent
    // just redeclares the variable, and one that opts out gets house === ''
    // and is byte-for-byte what it was before the feature existed.
    const html = composeDocument(
        { bodyHtml: '<p>x</p>', css: ':root { --doc-accent: #aa0000; }', name: 'x' },
        { houseStyleCss: ':root { --doc-accent: #123a5e; }' },
    );
    const base = html.indexOf('@page { size: A4');
    const house = html.indexOf('--doc-accent: #123a5e');
    const own = html.indexOf('--doc-accent: #aa0000');
    assert.ok(base > -1 && house > base, 'the house style follows the base geometry');
    assert.ok(own > house, "the document's own sheet comes last and therefore wins");
});

test('no house style CSS means the document is exactly what it was', () => {
    const withOut = composeDocument({ bodyHtml: '<p>x</p>', css: '.a{}', name: 'x' });
    const optedOut = composeDocument({ bodyHtml: '<p>x</p>', css: '.a{}', name: 'x' }, { houseStyleCss: '' });
    assert.strictEqual(withOut, optedOut);
});

test('the house style is sanitised like any other stylesheet', () => {
    // It is assembled from stored config, and config is edited by people.
    const html = composeDocument(
        { bodyHtml: '<p>x</p>', css: '', name: 'x' },
        { houseStyleCss: '@import url(https://evil.test/x.css); .a { background: url(https://evil.test/p.png); }' },
    );
    assert.ok(!/@import/.test(html));
    assert.ok(!/evil\.test/.test(html));
});

test('a logo data: URL survives the sanitiser — it is the one url() that must', () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    const html = composeDocument(
        { bodyHtml: '<div class="doc-logo"></div>', css: '', name: 'x' },
        { houseStyleCss: `:root { --doc-logo: url("${logo}"); }` },
    );
    assert.ok(html.includes(logo), 'the letterhead mark reaches the page');
});

test('a house style cannot break out of its <style> block either', () => {
    const html = composeDocument(
        { bodyHtml: '<p>x</p>', css: '', name: 'x' },
        { houseStyleCss: '.a{} </style><script>window.__PWNED=1</script><style>' },
    );
    const dom = parseAndRun(html);
    try {
        assert.strictEqual(dom.window.document.querySelectorAll('script').length, 0);
        assert.strictEqual(dom.window.__PWNED, undefined);
    } finally { dom.window.close(); }
});

test('the --doc-* vocabulary is ALWAYS defined, so opting out degrades instead of breaking', () => {
    // The failure this prevents is specific and invisible in review: a document
    // written for the letterhead says `background: var(--doc-accent); color:
    // #fff`. With the variable undefined that declaration is invalid at
    // computed-value time, the background falls back to transparent, and the
    // table header becomes white text on white paper — a PDF that looks like it
    // lost its header row. Defining the fallbacks in the BASE layer means an
    // opted-out document is neutral, not broken.
    const base = composeDocument({ bodyHtml: '<p>x</p>', css: '', name: 'x' }, { houseStyleCss: '' });
    for (const token of ['--doc-accent', '--doc-ink', '--doc-muted', '--doc-font', '--doc-logo-width']) {
        assert.match(base, new RegExp(`${token}:\\s*\\S`), `${token} has a default`);
    }
});

test('the house style overrides the base tokens rather than sitting beside them', () => {
    const html = composeDocument(
        { bodyHtml: '<p>x</p>', css: '', name: 'x' },
        { houseStyleCss: ':root { --doc-accent: #b0342c; }' },
    );
    const baseAccent = html.indexOf('--doc-accent: #1f2937');
    const houseAccent = html.indexOf('--doc-accent: #b0342c');
    assert.ok(baseAccent > -1 && houseAccent > baseAccent,
        'the org value comes later in the cascade and therefore wins');
});
