import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BLOCK_LIMITS, FRAME_CSP, FRAME_SANDBOX, HTML_ELEMENTS, SVG_ELEMENTS, buildFrameDocument, canonicalTemplate, domToTree,
    inspectTemplate, isSafeInlineStyle, isSafeSvgValue, parseEach, parseTemplate, renderBlock, sanitizeTree,
    serializeFrameBody, splitInterpolations, themeVariables,
} from './index.mjs';

const canon = (text, limits) => canonicalTemplate(text, limits);
const codes = (text) => canon(text).findings.map((f) => `${f.line}:${f.code}`);
const draw = (text, scope = {}, events = []) => {
    const drawn = renderBlock(canon(text).nodes, { scope, events });
    return { html: serializeFrameBody(drawn.nodes), emits: drawn.emits, problems: drawn.problems };
};

test('the frame runs no script and loads nothing but inline data', () => {
    assert.equal(FRAME_SANDBOX, 'allow-same-origin');
    assert.equal(FRAME_CSP, "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'");
});

test('the vocabulary holds no element that runs, loads or submits', () => {
    for (const name of ['script', 'style', 'link', 'meta', 'base', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'template', 'img', 'video', 'audio', 'source', 'track', 'picture', 'area', 'map', 'noscript', 'title', 'body', 'head', 'html', 'math', 'portal', 'slot', 'dialog', 'canvas']) {
        assert.equal(HTML_ELEMENTS.has(name), false, name);
    }
    for (const name of ['use', 'image', 'foreignobject', 'script', 'style', 'a', 'animate', 'animatemotion', 'animatetransform', 'set', 'filter', 'feimage', 'defs', 'pattern', 'mask', 'clippath', 'marker', 'symbol', 'svg', 'title', 'desc', 'switch', 'view', 'lineargradient']) {
        assert.equal(SVG_ELEMENTS.has(name), false, name);
    }
});

test('a clean template is stored as written, in its canonical quoting', () => {
    const text = '<div class="card">\n  <h2 title="t">Hi &amp; bye</h2>\n  <br>\n  <ul><li>a</li></ul>\n</div>';
    const { template, findings } = canon(text);
    assert.equal(template, text);
    assert.deepEqual(findings, []);
    assert.equal(canon("<p class='a'  hidden >x</p>").template, '<p class="a" hidden>x</p>');
});

test('canonical again is the same text, without findings', () => {
    const hostile = '<div onclick="x" class="a {{ k }}"><script>1</script><p title=\'{{ a ? "x" : "y" }}\'>{{ n<3 }} &copy; &#60;b&#62; <b>open<i>both</p><svg viewBox="0 0 1 1"><RECT X="1"/><use href="#a"/></svg><a href="x">l</a></div>';
    const once = canon(hostile);
    const twice = canon(once.template);
    assert.equal(twice.template, once.template);
    assert.deepEqual(twice.findings, []);
    assert.ok(once.findings.length >= 5);
});

test('everything that is left out is a finding with its line', () => {
    assert.deepEqual(codes('<p>a</p>\n<script>x</script>\n<p onclick="y" href="z">b</p>\n<!-- c -->\n<svg><use/></svg>\n</div>\n<b>'), [
        '2:template.element_refused',
        '3:template.attribute_refused',
        '3:template.attribute_refused',
        '4:template.comment',
        '5:template.element_refused',
        '6:template.end_tag_stray',
        '7:template.unclosed',
    ]);
    assert.match(canon('<p onclick="x">a</p>').findings[0].message, /runs no script/);
    assert.match(canon('<a href="x">a</a>').findings[0].message, /names no address/);
});

test('the content of an element a browser does not read as markup goes with it', () => {
    assert.equal(canon('<style>p{}</style><p>a</p><textarea><p>b</p></textarea><title><p>c</p></title><xmp><b></xmp>').template, '<p>a</p>');
    assert.equal(canon('<p>a</p><plaintext><p>b</p>').template, '<p>a</p>');
    assert.equal(canon('<p>a</p><SCRIPT>x</ScRiPt><p>b</p>').template, '<p>a</p><p>b</p>');
});

test('a formula is not read as markup, and a value with markup in it stays text', () => {
    assert.equal(canon('<p>{{ a<b ? "<i>" : \'x\' }}</p>').template, '<p>{{ a&lt;b ? "&lt;i&gt;" : \'x\' }}</p>');
    assert.equal(draw('<p title="{{ v }}">{{ v }}</p>', { v: '"><script>x</script>' }).html, '<p title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">"&gt;&lt;script&gt;x&lt;/script&gt;</p>');
    assert.deepEqual(splitInterpolations('a {{ {x: "}}"}.x }} b {{ c'), [{ text: 'a ' }, { expr: '{x: "}}"}.x' }, { text: ' b {{ c' }]);
});

test('attributes: each one has a rule, and a value outside it drops the attribute', () => {
    assert.equal(canon('<td colspan="2" rowspan="x" scope="col">a</td>').template, '<td colspan="2">a</td>');
    assert.equal(canon('<p dir="rtl" lang="nl-NL" role="note" id="a" name="b" tabindex="0" contenteditable draggable="true">a</p>').template, '<p dir="rtl" lang="nl-NL" role="note">a</p>');
    assert.equal(canon('<p aria-label="x" aria-="y" data-state="on" data-other="z">a</p>').template, '<p aria-label="x" data-state="on">a</p>');
    assert.equal(canon('<p class="a b-c 9x <i> _d">a</p>').template, '<p class="a b-c _d">a</p>');
    assert.equal(canon('<button data-emit="pick" data-value="row.id" type="submit" formaction="x" disabled>a</button>').template, '<button data-emit="pick" data-value="row.id" disabled>a</button>');
    assert.equal(canon('<p data-emit="pick">a</p><a data-emit="go" href="x" target="_blank" download>b</a>').template, '<p>a</p><a data-emit="go">b</a>');
});

test('a style attribute stays only without anything that can name an address', () => {
    assert.equal(isSafeInlineStyle('color: red; width: calc(100% - 4px); background: var(--bf-surface)'), true);
    for (const bad of ['background:url(x)', 'background:URL(x)', 'background:u\\72l(x)', 'a:b}p{c:d', 'content:"x"', "font-family:'x'", 'background:image-set(x)', 'x:expression(1)', 'a:b/**/', '@import x', 'background:image(x)', 'src(x)', 'a:<b']) {
        assert.equal(isSafeInlineStyle(bad), false, bad);
    }
    assert.equal(canon('<p style="color:red">a</p><p style="background:url(http://x/y)">b</p><p style="color:{{ c }}">c</p>').template, '<p style="color:red">a</p><p>b</p><p>c</p>');
});

test('svg: shapes and paint only, a value has no character an address needs', () => {
    assert.equal(isSafeSvgValue('M0 0 L10 10 Z'), true);
    assert.equal(isSafeSvgValue('rotate(45) translate(1,2)'), true);
    assert.equal(isSafeSvgValue('var(--bf-primary)'), true);
    for (const bad of ['url(#a)', 'URL(http://x)', 'http://x', 'a:b', '"x"', "u\\72l(x)"]) assert.equal(isSafeSvgValue(bad), false, bad);
    const text = '<svg viewBox="0 0 10 10" width="10" onload="x"><g transform="scale(2)"><rect x="1" width="2" height="2" fill="#f00" filter="url(#f)"/><image href="x"/><a href="y"><text>t</text></a><foreignObject><div>z</div></foreignObject></g><div>w</div></svg><rect/>';
    assert.equal(canon(text).template, '<svg viewbox="0 0 10 10" width="10"><g transform="scale(2)"><rect x="1" width="2" height="2" fill="#f00"></rect></g></svg>');
});

test('repeats, conditions, the item and index, and a list that is none', () => {
    const scope = { rows: [{ n: 'a', on: true }, { n: 'b', on: false }, { n: 'c', on: true }], none: null, word: 'x' };
    assert.equal(draw('<ul><li data-each="rows as r" data-if="r.on">{{ index }}{{ r.n }}</li></ul>', scope).html, '<ul><li>0a</li><li>2c</li></ul>');
    assert.equal(draw('<p data-each="rows">{{ item.n }}</p>', scope).html, '<p>a</p><p>b</p><p>c</p>');
    assert.equal(draw('<p data-each="none">x</p><p data-each="word">y</p><p data-if="none">z</p>', scope).html, '');
    assert.equal(draw('<div data-each="rows as r"><span data-each="rows as q">{{ r.n }}{{ q.n }}</span></div>', { rows: [{ n: 'a' }, { n: 'b' }] }).html, '<div><span>aa</span><span>ab</span></div><div><span>ba</span><span>bb</span></div>');
    assert.deepEqual(parseEach('filter(rows, it.kind == "x as y")'), { expr: 'filter(rows, it.kind == "x as y")', name: 'item' });
    assert.deepEqual(parseEach('rows as row'), { expr: 'rows', name: 'row' });
});

test('a formula sees the inputs and the repeat, nothing else, and a failing one draws nothing', () => {
    const { html, problems } = draw('<p>{{ a }}|{{ vars.x }}|{{ currentUser.name }}|{{ nope( }}|{{ constructor }}|{{ a.constructor.name }}</p>', { a: 1 });
    assert.equal(html, '<p>1|||||</p>');
    assert.equal(problems.length, 1);
    assert.deepEqual(inspectTemplate(canon('<p data-each="rows as r" class="{{ k }}">{{ r.n }}{{ index }}{{ other }}</p>{{ r }}{{ bad( }}').nodes), {
        refs: ['rows', 'k', 'other', 'r'], events: [], errors: [{ line: 1, message: '{{ bad( }}: ' + inspectTemplate(canon('{{ bad( }}').nodes).errors[0].message.split(': ').slice(1).join(': ') }],
    });
});

test('a control is numbered only for an event the page hands in, and the value stays with the host', () => {
    const text = '<button data-emit="pick" data-value="row">a</button><a data-emit="pick">b</a><button data-emit="other">c</button>';
    const wired = draw(text, { row: { id: 7 } }, ['pick']);
    assert.equal(wired.html, '<button type="button" data-bf-emit="0">a</button><a data-bf-emit="1" role="button" tabindex="0">b</a><button type="button">c</button>');
    assert.deepEqual(wired.emits, [{ event: 'pick', value: { id: 7 } }, { event: 'pick', value: undefined }]);
    assert.equal(draw(text, { row: 1 }, []).html, '<button type="button">a</button><a>b</a><button type="button">c</button>');
    // An author cannot write the host's own attributes.
    assert.equal(canon('<button data-bf-emit="0" type="submit">a</button><a tabindex="0" role="button">b</a>').template, '<button>a</button><a role="button">b</a>');
});

test('limits: characters, nodes, depth, repeat and what one block draws', () => {
    assert.equal(canon('<p>abc</p>', { maxChars: 5 }).template, '');
    assert.equal(canon('<p>abc</p>', { maxChars: 5 }).findings[0].code, 'template.too_long');
    assert.equal(canon('<p>a</p><p>b</p><p>c</p>', { maxNodes: 4 }).template, '<p>a</p><p>b</p>');
    assert.equal(canon('<div><div><div>x</div></div></div>', { maxDepth: 2 }).template, '<div><div></div></div>');
    const rows = Array.from({ length: BLOCK_LIMITS.MAX_REPEAT + 5 }, (_, i) => i);
    const many = renderBlock(canon('<i data-each="rows">{{ item }}</i>').nodes, { scope: { rows } });
    assert.equal(many.nodes.length, BLOCK_LIMITS.MAX_REPEAT);
    assert.match(many.problems[0], /at most 1000 items/);
    const capped = renderBlock(canon('<i data-each="rows">{{ item }}</i>').nodes, { scope: { rows }, maxOutputNodes: 10 });
    assert.equal(capped.nodes.length, 5);
    const deep = '<div>'.repeat(400) + 'x' + '</div>'.repeat(400);
    assert.ok(canon(deep).template.length > 0);
});

test('the writer is a gate of its own: a tree that skipped the allow-list is still written as vocabulary', () => {
    const forged = [
        { t: 'el', name: 'link', svg: false, attrs: [['rel', 'prerender'], ['href', 'http://x/']], children: [], line: 0 },
        { t: 'el', name: 'p', svg: false, attrs: [['onclick', 'x()'], ['href', 'http://x/'], ['src', 'http://x/'], ['class', 'a'], ['data-bf-emit', '0'], ['type', 'button'], ['tabindex', '0']], children: [{ t: 'text', value: '<script>x</script>', line: 0 }, { t: 'el', name: 'script', svg: false, attrs: [], children: [{ t: 'text', value: 'x', line: 0 }], line: 0 }], line: 0 },
        { t: 'el', name: 'button', svg: false, attrs: [['data-bf-emit', 'x'], ['type', 'submit'], ['formaction', 'http://x/']], children: [], line: 0 },
        { t: 'el', name: 'svg', svg: true, attrs: [], children: [{ t: 'el', name: 'use', svg: true, attrs: [['href', 'http://x/']], children: [], line: 0 }, { t: 'el', name: 'div', svg: false, attrs: [], children: [], line: 0 }], line: 0 },
    ];
    assert.equal(serializeFrameBody(forged), '<p class="a">&lt;script&gt;x&lt;/script&gt;</p><button></button><svg></svg>');
});

test('the browser\'s tree is held to the same lists (a tree with other namespaces and no lines)', () => {
    const SVG = 'http://www.w3.org/2000/svg';
    const HTML = 'http://www.w3.org/1999/xhtml';
    const el = (localName, namespaceURI, attributes = [], childNodes = []) => ({ nodeType: 1, localName, namespaceURI, attributes, childNodes });
    const body = { nodeType: 1, childNodes: [
        el('p', HTML, [{ name: 'ONCLICK', value: 'x' }, { name: 'class', value: 'a' }], [{ nodeType: 3, nodeValue: 'hi', childNodes: [] }, { nodeType: 8, nodeValue: 'c', childNodes: [] }]),
        el('svg', SVG, [], [el('rect', SVG, [{ name: 'x', value: '1' }]), el('p', HTML), el('use', SVG)]),
        el('math', 'http://www.w3.org/1998/Math/MathML', [], [el('mi', 'http://www.w3.org/1998/Math/MathML')]),
        el('rect', SVG), el('p', SVG), el('script', HTML),
    ] };
    const clean = sanitizeTree(domToTree(body));
    assert.equal(serializeFrameBody(clean.nodes), '<p class="a">hi</p><svg><rect x="1"></rect></svg>');
    assert.equal(clean.findings.length, 7);
    assert.ok(clean.findings.every((f) => f.line === 0));
});

test('the frame document: the theme says colours and lengths only, the stylesheet cannot end its element', () => {
    assert.equal(themeVariables({ primary: '#2563eb', 'text-muted': 'rgb(1, 2, 3)', font: '"Inter", sans-serif', bad: 'red;}</style><p>', 'x;y': 'red', url: 'url(http://x/)' }), '--bf-primary:#2563eb;--bf-text-muted:rgb(1, 2, 3);--bf-font:Inter, sans-serif;--bf-bad:redstylep;');
    const doc = buildFrameDocument({ body: '<p>a</p>', css: 'p{color:red}</style><script>x</script>', theme: { primary: 'red' }, lang: 'nl"><script>', dark: true });
    assert.ok(doc.startsWith('<!doctype html><html lang="nlscript" data-appearance="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'));
    assert.ok(!doc.includes('<script'));
    assert.ok(doc.includes('<style></style></head><body><p>a</p></body></html>'));
});

test('the strict reader: entities, quotes, tags that never close', () => {
    assert.equal(canon('a &amp; b &lt; c &nbsp; &#65; &#x42; &copy; &#0; & d').template, 'a &amp; b &lt; c   A B &amp;copy; &amp;#0; &amp; d');
    assert.equal(canon('<p title=a class=b>x</p>').template, '<p title="a" class="b">x</p>');
    assert.equal(canon('<p>a</p><p title="never').template, '<p>a</p>');
    assert.equal(canon('a < b and <3').template, 'a &lt; b and &lt;3');
    assert.equal(canon('<div/><p>a</p>').template, '<div></div><p>a</p>');
    assert.equal(canon('<p title="a" title="b">x</p>').template, '<p title="a">x</p>');
    assert.equal(parseTemplate('a\r\nb\rc\0').nodes[0].value, 'a\nb\nc');
    assert.deepEqual(canon(null).template, '');
});
