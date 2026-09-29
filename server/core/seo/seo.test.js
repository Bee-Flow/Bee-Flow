/**
 * The SEO layer, tested where it is pure.
 *
 * Each assertion here corresponds to something the audit found MISSING from
 * the shipped site — no canonical, no hreflang, no JSON-LD, no twitter card,
 * a hardcoded `<html lang="en">` on Dutch pages, a `noIndex` flag that only
 * client JS ever applied. They are pinned so a refactor cannot quietly return
 * the site to being invisible.
 *
 * Run: cd server && node --test core/seo/seo.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { parsePublicPath, buildPublicPath, RESERVED_TOP_LEVEL } = require('./publicPath');
const { buildHead } = require('./head');
const { faqPage, buildJsonLd } = require('./jsonld');
const { renderBlocks, PREHYDRATE_CSS } = require('./renderBlocks');
const { injectIntoShell } = require('./inject');
const { buildSitemap, buildRobots, buildLlmsTxt } = require('./sitemap');
const { hasTranslation, localesForPage } = require('./locales');
const { LEGACY_SLUGS } = require('./legacySlugs');
const { esc, jsonForScript, clamp } = require('./html');

const ORIGIN = 'https://beeflow.nl';
const LOCALES = ['en', 'nl'];

// ── publicPath ───────────────────────────────────────────────────────

test('a bare slug is a marketing path with no locale', () => {
    assert.deepStrictEqual(parsePublicPath('/pricing', LOCALES), { locale: null, slug: 'pricing' });
    assert.deepStrictEqual(parsePublicPath('/', LOCALES), { locale: null, slug: '' });
});

test('a locale prefix is recognised, including the bare locale homepage', () => {
    assert.deepStrictEqual(parsePublicPath('/nl/pricing', LOCALES), { locale: 'nl', slug: 'pricing' });
    assert.deepStrictEqual(parsePublicPath('/nl', LOCALES), { locale: 'nl', slug: '' });
    assert.deepStrictEqual(parsePublicPath('/nl/', LOCALES), { locale: 'nl', slug: '' });
});

test('a two-letter segment that is NOT a configured locale stays a slug', () => {
    // Otherwise a future page at /it would silently become an Italian homepage.
    assert.deepStrictEqual(parsePublicPath('/it', LOCALES), { locale: null, slug: 'it' });
    assert.strictEqual(parsePublicPath('/it/pricing', LOCALES), null);
});

test('app routes and multi-segment paths are refused', () => {
    for (const p of ['/app', '/api', '/admin', '/auth', '/privacy', '/a/b/c', '/nl/a/b']) {
        assert.strictEqual(parsePublicPath(p, LOCALES), null, p);
    }
    // 'legal' and 'terms' were released to the CMS when the static legal-docs
    // feature was retired — they parse as ordinary slugs now.
    assert.deepStrictEqual(parsePublicPath('/legal', LOCALES), { locale: null, slug: 'legal' });
    assert.deepStrictEqual(parsePublicPath('/terms', LOCALES), { locale: null, slug: 'terms' });
});

test('the default locale is served WITHOUT a prefix', () => {
    // Prefixing it too would mean /pricing and /en/pricing both resolve —
    // the exact duplication this module exists to end.
    assert.strictEqual(buildPublicPath('en', 'pricing', 'en'), '/pricing');
    assert.strictEqual(buildPublicPath('nl', 'pricing', 'en'), '/nl/pricing');
    assert.strictEqual(buildPublicPath('en', '', 'en'), '/');
    assert.strictEqual(buildPublicPath('nl', '', 'en'), '/nl');
});

// ── head ─────────────────────────────────────────────────────────────

const page = {
    title: 'Pricing',
    seo: { metaTitle: 'Pricing — Bee Flow', metaDescription: 'What it costs.' },
    blocks: [],
};

test('emits the tags that did not exist anywhere before', () => {
    const head = buildHead({
        origin: ORIGIN, slug: 'pricing', locale: 'en', defaultLocale: 'en',
        locales: LOCALES, page, design: {}, siteName: 'Bee Flow',
    });
    assert.match(head, /<link rel="canonical" href="https:\/\/beeflow\.nl\/pricing">/);
    assert.match(head, /property="og:url" content="https:\/\/beeflow\.nl\/pricing"/);
    assert.match(head, /name="twitter:card"/);
    assert.match(head, /application\/ld\+json/);
    assert.match(head, /hreflang="nl" href="https:\/\/beeflow\.nl\/nl\/pricing"/);
    assert.match(head, /hreflang="x-default"/);
});

test('the canonical of a Dutch page is the Dutch URL, not the English one', () => {
    const head = buildHead({
        origin: ORIGIN, slug: 'pricing', locale: 'nl', defaultLocale: 'en',
        locales: LOCALES, page, design: {}, siteName: 'Bee Flow',
    });
    assert.match(head, /<link rel="canonical" href="https:\/\/beeflow\.nl\/nl\/pricing">/);
});

test('noIndex reaches the markup — it used to be applied by client JS only', () => {
    const hidden = { ...page, seo: { ...page.seo, noIndex: true } };
    const head = buildHead({
        origin: ORIGIN, slug: 'secret', locale: 'en', defaultLocale: 'en',
        locales: LOCALES, page: hidden, design: {}, siteName: 'Bee Flow',
    });
    assert.match(head, /name="robots" content="noindex, nofollow"/);
});

test('a cms/ asset key becomes an absolute URL — a relative og:image is ignored by scrapers', () => {
    const withImage = { ...page, seo: { ...page.seo, ogImage: 'cms/hero.png' } };
    const head = buildHead({
        origin: ORIGIN, slug: '', locale: 'en', defaultLocale: 'en',
        locales: LOCALES, page: withImage, design: {}, siteName: 'Bee Flow',
    });
    assert.match(head, /og:image" content="https:\/\/beeflow\.nl\/api\/cms\/asset\/cms\/hero\.png"/);
});

test('an empty description emits no tag rather than an empty one', () => {
    const bare = { title: 'X', seo: {}, blocks: [] };
    const head = buildHead({
        origin: ORIGIN, slug: 'x', locale: 'en', defaultLocale: 'en',
        locales: ['en'], page: bare, design: {}, siteName: 'Bee Flow',
    });
    assert.ok(!/name="description"/.test(head));
    assert.ok(!/hreflang/.test(head), 'a single-locale site needs no alternates');
});

test('the design fonts reach the head as preloads and first-paint variables', () => {
    // The client used to apply fonts in a post-mount effect, so the h1 first
    // painted in the system stack and re-melted into Fraunces — a layout
    // shift on the largest text on the page, on every load.
    const head = buildHead({
        origin: ORIGIN, slug: '', locale: 'en', defaultLocale: 'en', locales: ['en'],
        page, design: { fonts: { heading: 'Fraunces', body: 'Inter', mono: 'IBM Plex Mono' } },
        siteName: 'Bee Flow',
    });
    assert.match(head, /rel="preload" as="font" type="font\/woff2" href="\/fonts\/fraunces\/[^"]+" crossorigin/);
    assert.match(head, /--font-heading: Fraunces, "Fraunces Fallback",/);
    assert.match(head, /--font-body: Inter, "Inter Fallback",/);
    assert.match(head, /--font-mono: "IBM Plex Mono", "IBM Plex Mono Fallback",/);
    // ONLY the heading family is preloaded. Body and mono both ship
    // metric-matched fallbacks (size-adjust + ascent/descent overrides in
    // marketing/self-hosted-fonts.css), so their swap cannot shift layout —
    // and on a throttled mobile link every preloaded byte is taken from the
    // render-blocking stylesheet that FCP is actually waiting for.
    assert.ok(!head.includes('href="/fonts/inter/'),
        'the body font must not be preloaded — it has a metric-matched fallback');
    assert.ok(!head.includes('preload" as="font" type="font/woff2" href="/fonts/ibm-plex-mono'));
    assert.strictEqual((head.match(/rel="preload" as="font"/g) || []).length, 1,
        'exactly one font preload: the heading family');
});

test('a font family carrying markup cannot break out of the <style> block', () => {
    // The variables land in a raw-text element, where entities are NOT decoded
    // — so a literal `</style>` in a family name would end the element and the
    // rest would be parsed as markup. Escaping cannot help there; the name is
    // dropped instead. cmsStore.sanitizeDesign refuses to store such a value,
    // and this is the second lock: an imported bundle or a legacy row must not
    // reach the public head either.
    const head = buildHead({
        origin: ORIGIN, slug: '', locale: 'en', defaultLocale: 'en', locales: ['en'],
        page,
        design: { fonts: {
            heading: '</style><script src=https://attacker.example/x.js></script>',
            body: 'Inter',
        } },
        siteName: 'Bee Flow',
    });
    assert.ok(!head.includes('</style><script'), 'the style element must not be closable');
    assert.ok(!head.includes('attacker.example'));
    assert.ok(!head.includes('--font-heading'), 'a name that is not a family name emits no variable');
    assert.match(head, /--font-body: Inter, "Inter Fallback",/, 'the sibling family is unaffected');
});

test('an unknown design font gets no preload and no fabricated fallback face', () => {
    const head = buildHead({
        origin: ORIGIN, slug: '', locale: 'en', defaultLocale: 'en', locales: ['en'],
        page, design: { fonts: { heading: 'Playfair Display' } }, siteName: 'Bee Flow',
    });
    assert.ok(!head.includes('as="font"'), 'no file path is known for a CDN family');
    assert.match(head, /--font-heading: "Playfair Display", -apple-system/);
});

// ── JSON-LD ──────────────────────────────────────────────────────────

test('FAQPage is derived from the faq block that was already on the page', () => {
    const blocks = [{
        type: 'faq',
        content: { items: [{ question: 'Q1?', answer: 'A1.' }, { question: '', answer: 'orphan' }] },
    }];
    const faq = faqPage(blocks);
    assert.strictEqual(faq.mainEntity.length, 1, 'an answer with no question is not a Question');
    assert.strictEqual(faq.mainEntity[0].acceptedAnswer.text, 'A1.');
});

test('no faq block means no FAQPage node — an empty one is invalid markup', () => {
    assert.strictEqual(faqPage([{ type: 'hero', content: {} }]), null);
    const graph = buildJsonLd({
        origin: ORIGIN, siteName: 'Bee Flow', url: `${ORIGIN}/x`, title: 'X',
        description: 'd', locale: 'en', slug: 'x', localePrefix: '', blocks: [],
    })['@graph'];
    assert.ok(!graph.some(n => n['@type'] === 'FAQPage'));
});

test('the graph carries no invented commercial data', () => {
    const graph = buildJsonLd({
        origin: ORIGIN, siteName: 'Bee Flow', url: `${ORIGIN}/`, title: 'Home',
        description: 'd', locale: 'en', slug: '', localePrefix: '',
        blocks: [], isProductPage: true,
    })['@graph'];
    const json = JSON.stringify(graph);
    for (const bad of ['aggregateRating', 'offers', 'price', 'reviewCount']) {
        assert.ok(!json.includes(bad), `${bad} must not be fabricated`);
    }
    assert.ok(graph.some(n => n['@type'] === 'SoftwareApplication'));
    assert.ok(!graph.some(n => n['@type'] === 'BreadcrumbList'), 'no crumbs on the homepage');
});

// ── block rendering ──────────────────────────────────────────────────

test('emits the real headings and prose a crawler needs', () => {
    const html = renderBlocks([
        { type: 'hero', content: { eyebrow: 'Roadmap', titleParts: [{ text: 'Build it' }, { text: 'here' }], lead: 'A lead.' } },
        { type: 'features', content: { title: 'Anatomy', items: [{ title: 'One', body: 'First.' }] } },
    ], { fallbackTitle: 'Page' });

    assert.match(html, /<h1>Build it here<\/h1>/);
    assert.match(html, /A lead\./);
    assert.match(html, /First\./);
    assert.strictEqual((html.match(/<h1>/g) || []).length, 1, 'exactly one h1');
});

test('is generic over block type — a type it has never seen still renders', () => {
    // The roadmap block was added after this serialiser and needed no change.
    const html = renderBlocks([{
        type: 'roadmap',
        content: { title: 'What we build', items: [{ title: 'Legal', body: 'A matter file', status: 'beta' }] },
    }]);
    assert.match(html, /Legal/);
    assert.match(html, /A matter file/);
    assert.ok(!html.includes('beta'), 'structural values must not leak into the copy');
});

test('never emits a src, href or embed as text', () => {
    const html = renderBlocks([{
        type: 'hero',
        content: { title: 'T', media: { src: 'cms/x.png' }, popupEmbed: '<script>alert(1)</script>' },
    }]);
    assert.ok(!html.includes('cms/x.png'));
    assert.ok(!html.includes('alert(1)'));
});

test('escapes content — the CMS is exactly where a stored XSS would pay off', () => {
    const html = renderBlocks([{ type: 'hero', content: { title: '<img src=x onerror=alert(1)>' } }]);
    assert.ok(!html.includes('<img'));
    assert.match(html, /&lt;img/);
});

test('a disabled block contributes nothing', () => {
    assert.strictEqual(renderBlocks([{ type: 'hero', enabled: false, content: { title: 'Hidden' } }]), '');
});

// ── injection ────────────────────────────────────────────────────────

const SHELL = `<!doctype html>
<html lang="en">
<head>
  <title>Bee Flow - AI</title>
  <meta name="description" content="Chat with AI agents powered by Bee Flow" />
  <link rel="icon" type="image/svg+xml" href="/app-icon.svg" />
</head>
<body><div id="root"></div></body>
</html>`;

test('the app defaults are REMOVED, not just followed by better ones', () => {
    // Two <title> elements is undefined behaviour and scrapers commonly take
    // the first — leaving it would preserve the exact bug being fixed.
    const out = injectIntoShell(SHELL, {
        head: '<title>Pricing — Bee Flow</title>', body: '<h1>Pricing</h1>', lang: 'nl',
    });
    assert.strictEqual((out.match(/<title>/g) || []).length, 1);
    assert.ok(!out.includes('Bee Flow - AI'));
    assert.ok(!out.includes('Chat with AI agents powered by Bee Flow'));
});

test('sets <html lang> to the served locale', () => {
    const out = injectIntoShell(SHELL, { head: '', body: '', lang: 'nl' });
    assert.match(out, /<html lang="nl">/);
});

test('a locale that is not a language tag cannot become markup in <html>', () => {
    // The locale is only URL-derived when the path carries a prefix; otherwise
    // it is cms_default_locale — stored data, writable through the CMS admin
    // API and read on EVERY public request, so no publish step is needed.
    const out = injectIntoShell(SHELL, {
        head: '', body: '',
        lang: 'en"><script src=https://attacker.example/x.js></script><b x="',
    });
    assert.ok(!out.includes('attacker.example'));
    assert.strictEqual((out.match(/<script/g) || []).length, 0);
    assert.match(out, /<html lang="en">/, 'an unusable locale falls back to en, not to a lie');
});

test('a locale containing a $ replacement pattern is not expanded', () => {
    // String.replace interprets $1 / $& / $` in a replacement STRING, so a
    // template literal here would splice parts of the shell back into the tag.
    const out = injectIntoShell(SHELL, { head: '', body: '', lang: '$1$&' });
    assert.match(out, /<html lang="en">/);
});

test('content lands inside #root, where React will replace it', () => {
    const out = injectIntoShell(SHELL, { head: '', body: '<h1>Hi</h1>', lang: 'en' });
    assert.match(out, /<div id="root"><h1>Hi<\/h1><\/div>/);
});

// ── sitemap + robots ─────────────────────────────────────────────────

const PAGES = [
    { id: 'p1', slug: 'home', isHomepage: true, seo: {}, updatedAt: '2026-07-29T10:00:00Z' },
    { id: 'p2', slug: 'pricing', seo: {}, updatedAt: '2026-07-29T10:00:00Z' },
    { id: 'p3', slug: 'hidden', seo: { noIndex: true } },
    { id: 'p4', slug: 'oops', isNotFound: true, seo: {} },
];

test('every indexable page appears once per locale, with alternates', () => {
    const xml = buildSitemap(PAGES, { origin: ORIGIN, defaultLocale: 'en', locales: LOCALES });
    assert.match(xml, /<loc>https:\/\/beeflow\.nl\/<\/loc>/);
    assert.match(xml, /<loc>https:\/\/beeflow\.nl\/nl<\/loc>/);
    assert.match(xml, /<loc>https:\/\/beeflow\.nl\/nl\/pricing<\/loc>/);
    assert.match(xml, /hreflang="x-default"/);
    assert.strictEqual((xml.match(/<url>/g) || []).length, 4, '2 pages x 2 locales');
});

test('a page hidden from search engines is not advertised to them', () => {
    const xml = buildSitemap(PAGES, { origin: ORIGIN, defaultLocale: 'en', locales: LOCALES });
    assert.ok(!xml.includes('/hidden'));
    assert.ok(!xml.includes('/oops'), 'the 404 page is not a destination');
});

test('robots points at the sitemap and keeps the demos out of the index', () => {
    const txt = buildRobots({ origin: ORIGIN, allow: true });
    assert.match(txt, /Sitemap: https:\/\/beeflow\.nl\/sitemap\.xml/);
    assert.match(txt, /Disallow: \/__demo__\//);
    assert.match(txt, /Disallow: \/app/);
});

test('an unknown host is disallowed outright rather than inviting crawlers', () => {
    assert.match(buildRobots({ origin: ORIGIN, allow: false }), /User-agent: \*\nDisallow: \/$/m);
});

test('the configured host is never handed a blanket Disallow', () => {
    // The whole SEO layer shipped switched off for months because PUBLIC_SITE_URL
    // was unset in the cluster, so isIndexableHost() said false and this function
    // returned "Disallow: /" for beeflow.nl itself. Nothing failed loudly; the
    // site was simply absent from the index. Pin the allowed branch so a future
    // refactor of that gate cannot silently re-block the real site.
    const txt = buildRobots({ origin: ORIGIN, allow: true });
    assert.ok(!/^Disallow: \/$/m.test(txt), 'the indexable host must not be blanket-disallowed');
    assert.match(txt, /^Allow: \/$/m);
});

test('the /app disallow is anchored so it cannot swallow a marketing slug', () => {
    // `Disallow: /app` is a PREFIX rule — it would also hide /applicaties or
    // /apps-overzicht the day one is published, and that failure is invisible
    // until someone notices the page never ranks.
    const txt = buildRobots({ origin: ORIGIN, allow: true });
    assert.match(txt, /^Disallow: \/app\$$/m);
    assert.match(txt, /^Disallow: \/app\/$/m);
    assert.ok(!/^Disallow: \/app$/m.test(txt), 'the unanchored prefix rule must be gone');
});

test('a page is only advertised in a language it was actually translated into', () => {
    // languageStore seeds en/nl/de/fr into every install, so "nl is available"
    // says nothing about whether THIS page has Dutch on it. Advertising a
    // /nl/ alternate that serves English invalidates the hreflang cluster for
    // the whole site, not just the one page.
    const pages = [
        { id: 'p1', slug: 'home', isHomepage: true, seo: {}, locales: ['en', 'nl'] },
        { id: 'p2', slug: 'pricing', seo: {}, locales: ['en'] },   // untranslated
    ];
    const xml = buildSitemap(pages, { origin: ORIGIN, defaultLocale: 'en', locales: LOCALES });

    assert.match(xml, /<loc>https:\/\/beeflow\.nl\/nl<\/loc>/, 'translated page keeps its /nl URL');
    assert.ok(!xml.includes('<loc>https://beeflow.nl/nl/pricing</loc>'),
        'an untranslated page must not be listed under /nl/');
    assert.ok(!/\/nl\/pricing/.test(xml), 'nor advertised as an alternate of the English one');
    assert.strictEqual((xml.match(/<url>/g) || []).length, 3, 'home x2 locales + pricing x1');
});

test('an override that exists but is empty is not a translation', () => {
    // Opening a language in the editor and writing nothing still writes the
    // key. Treating that as "translated" is how a page ends up advertising a
    // /nl/ URL that serves English.
    assert.strictEqual(hasTranslation(null), false);
    assert.strictEqual(hasTranslation({ version: 1, blocks: {} }), false);
    assert.strictEqual(hasTranslation({ version: 1, blocks: {}, seo: { metaTitle: '  ' } }), false);
    assert.strictEqual(hasTranslation({ version: 1, blocks: { b1: { text: 'Prijzen' } } }), true);
    assert.strictEqual(hasTranslation({ version: 1, blocks: {}, seo: { metaTitle: 'Prijzen' } }), true);
});

test('localesForPage answers per page, not per site', () => {
    const snapshot = {
        pageLocaleOverrides: {
            p1: { nl: { blocks: { b1: { text: 'Hallo' } } } },
            p2: { nl: { blocks: {} } },              // opened, never written
        },
    };
    assert.deepStrictEqual(localesForPage(snapshot, 'p1', 'en', LOCALES), ['en', 'nl']);
    assert.deepStrictEqual(localesForPage(snapshot, 'p2', 'en', LOCALES), ['en']);
    assert.deepStrictEqual(localesForPage(snapshot, 'p3', 'en', LOCALES), ['en'], 'no overrides at all');
    assert.deepStrictEqual(localesForPage(null, 'p1', 'en', LOCALES), ['en'], 'no snapshot');
});

test('the retired Dutch V1 slugs still redirect somewhere real', () => {
    // These are the URLs Google actually lists for "bee flow" (the sitelinks
    // under the beeflow.nl result). Each answered 200 with the app shell, so
    // the stale result stayed indexed and the visitor landed in the app.
    const liveSlugs = new Set([
        'about', 'knowledge', 'pricing', 'notebooks', 'platform', 'microsoft-alternative',
    ]);
    for (const [from, to] of Object.entries(LEGACY_SLUGS)) {
        assert.ok(liveSlugs.has(to), `${from} redirects to ${to}, which must be a live page`);
        assert.ok(!LEGACY_SLUGS[to], `${to} is a destination and must not itself be retired`);
    }
    for (const dutch of ['overons', 'kennisbank', 'prijzen', 'notitieboeken']) {
        assert.ok(LEGACY_SLUGS[dutch], `${dutch} is still indexed by Google and needs a 301`);
    }
});

test('llms.txt is Markdown with a heading and links, and hides noIndex pages', () => {
    // /llms.txt used to fall through to the SPA, so an assistant asking for it
    // got the app shell. Lighthouse's agentic-browsing audit reported exactly
    // that: "missing a required H1" and "does not appear to contain any links".
    const txt = buildLlmsTxt(PAGES.concat([{ slug: 'n8n-alternative', title: 'vs n8n', seo: {} }]), {
        origin: ORIGIN, siteName: 'Bee Flow', summary: 'European AI workspace.',
    });
    assert.match(txt, /^# Bee Flow$/m, 'needs exactly the H1 the audit asks for');
    assert.match(txt, /^- \[Home\]\(https:\/\/beeflow\.nl\/\)/m);
    assert.match(txt, /^## Comparisons$/m);
    assert.match(txt, /^- \[vs n8n\]\(https:\/\/beeflow\.nl\/n8n-alternative\)/m);
    assert.ok(!txt.includes('/hidden'), 'a noIndex page is not offered to models either');
    assert.ok(!txt.includes('/oops'), 'nor is the 404 page');
});

test('a sitemap with nothing to say is still XML, never HTML', () => {
    // Falling through to the SPA returned 200 text/html for /sitemap.xml — a
    // page of HTML claiming to be a sitemap. That is what Search Console has
    // been reporting as an error, and it reads as success to everything else.
    const xml = buildSitemap([], { origin: ORIGIN });
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset/);
    assert.match(xml, /<\/urlset>/);
    assert.ok(!xml.includes('<url>'));
});

// ── escaping ─────────────────────────────────────────────────────────

test('JSON in a <script> cannot break out of the block', () => {
    const out = jsonForScript({ t: '</script><script>alert(1)</script>' });
    assert.ok(!out.includes('</script>'));
});

test('esc covers the five characters that matter, clamp cuts on a word', () => {
    assert.strictEqual(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
    assert.strictEqual(clamp('one two three four', 12), 'one two…');
});

// ── the two copies of the routing rule ───────────────────────────────

test('the server and client routing rules have not drifted', () => {
    // publicPath.js duplicates RESERVED_TOP_LEVEL and the locale allowlist from
    // agent-hub/src/utils/cmsPublicRouting.js, because that file is browser ESM
    // in a different package. If they disagree the server renders a page the
    // client then refuses to route: the visitor sees content for an instant and
    // is bounced to /app. Parsed rather than imported, for the same reason.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
        path.join(__dirname, '../../../agent-hub/src/utils/cmsPublicRouting.js'), 'utf8');

    // Substring slicing rather than a regex: the literals span several lines
    // and the escaping needed to match them is its own source of bugs.
    const setLiteral = (name) => {
        const open = src.indexOf(`${name} = new Set([`);
        assert.ok(open >= 0, `${name} not found in the client module`);
        const from = open + `${name} = new Set([`.length;
        const to = src.indexOf('])', from);
        assert.ok(to > from, `${name} literal is not closed`);
        return new Set([...src.slice(from, to).matchAll(/'([^']+)'/g)].map(x => x[1]));
    };

    const clientReserved = setLiteral('RESERVED_TOP_LEVEL');
    assert.deepStrictEqual(
        [...RESERVED_TOP_LEVEL].sort(), [...clientReserved].sort(),
        'RESERVED_TOP_LEVEL differs between server/core/seo/publicPath.js and the client');

    // Every prefixed locale must be one the server will also parse.
    for (const code of setLiteral('LOCALE_PREFIXES')) {
        assert.deepStrictEqual(
            parsePublicPath(`/${code}/pricing`, ['en', code]),
            { locale: code, slug: 'pricing' },
            `the server does not recognise the client's /${code}/ prefix`);
    }
});

// ── internal links in the server-rendered body ───────────────────────

test('a resolved CTA becomes a real internal anchor', () => {
    // Before this, the SSR body contained no <a> at all — internal link
    // structure only existed after hydration.
    const html = renderBlocks([{
        type: 'hero',
        content: {
            title: 'T',
            primaryCta: { enabled: true, label: 'Try it', link: { href: '/self-hosting' } },
        },
    }]);
    assert.match(html, /<a href="\/self-hosting">Try it<\/a>/);
});

test('external, protocol-relative and anchor CTAs stay client-side', () => {
    const html = renderBlocks([{
        type: 'cta',
        content: {
            title: 'T',
            button: { label: 'GitHub', link: { href: 'https://github.com/x' } },
            secondaryCta: { label: 'Evil', link: { href: '//evil.example' } },
            tertiary: { label: 'Jump', link: { href: '#faq' } },
        },
    }]);
    assert.ok(!html.includes('<a '), 'no anchor for any of them');
    assert.match(html, /<p>GitHub<\/p>/, 'the label itself still renders, as before');
});

test('a card with prose of its own is not swallowed by the CTA rule', () => {
    const html = renderBlocks([{
        type: 'features',
        content: {
            items: [{ title: 'Sharing', body: 'Org or group.', label: 'More', link: { href: '/identity-access' } }],
        },
    }]);
    assert.match(html, /Sharing/);
    assert.match(html, /Org or group\./);
    assert.ok(!html.includes('<a '), 'mixed objects keep their normal rendering');
});

test('a CTA href is escaped like everything else', () => {
    const html = renderBlocks([{
        type: 'hero',
        content: { primaryCta: { label: 'x', link: { href: '/a"onmouseover="alert(1)' } } },
    }]);
    assert.ok(!html.includes('"onmouseover'));
    assert.match(html, /&quot;onmouseover/);
});

// ── compare-table ────────────────────────────────────────────────────

test('a comparison table is emitted as a real <table>, cells escaped', () => {
    const html = renderBlocks([{
        type: 'compare-table',
        content: {
            title: 'Bee Flow vs Zapier',
            leftLabel: 'Bee Flow', rightLabel: 'Zapier',
            rows: [
                { aspect: 'Hosting', left: 'Self-hosted or EU cloud', right: 'Hosted only' },
                { aspect: '<b>x</b>', left: 'a', right: 'b' },
            ],
            footnote: 'Their docs are the authority on their side.',
        },
    }]);
    assert.match(html, /<table>/);
    assert.match(html, /<th>Bee Flow<\/th><th>Zapier<\/th>/);
    assert.match(html, /<th>Hosting<\/th><td>Self-hosted or EU cloud<\/td><td>Hosted only<\/td>/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.ok(!html.includes('<b>x</b>'));
    assert.match(html, /Their docs are the authority/, 'footnote renders as prose');
});

test('a comparison table with no filled rows emits no table', () => {
    const html = renderBlocks([{
        type: 'compare-table',
        content: { title: 'T', leftLabel: 'A', rightLabel: 'B', rows: [{ aspect: '', left: '', right: '' }] },
    }]);
    assert.ok(!html.includes('<table>'));
});

// ── sitemap priority + per-page lastmod ──────────────────────────────

test('every sitemap entry carries a priority — unknown slugs get the explicit default', () => {
    const pages = [
        { id: 'p1', slug: 'pricing', seo: {}, updatedAt: '2026-08-01T10:00:00Z' },
        { id: 'p2', slug: 'brand-new-page', seo: {}, updatedAt: '2026-08-01T10:00:00Z' },
    ];
    const xml = buildSitemap(pages, { origin: ORIGIN, defaultLocale: 'en', locales: ['en'] });
    assert.match(xml, /<priority>0\.9<\/priority>/, 'mapped slug keeps its value');
    assert.match(xml, /<priority>0\.5<\/priority>/, 'unmapped slug gets the spec default, visibly');
    assert.strictEqual((xml.match(/<priority>/g) || []).length, 2, 'no silent omissions');
});

test('lastmod is per page — one publish must not re-date every URL', () => {
    const pages = [
        { id: 'p1', slug: 'pricing', seo: {}, updatedAt: '2026-08-05T10:00:00Z' },
        { id: 'p2', slug: 'about', seo: {}, updatedAt: '2026-06-01T09:00:00Z' },
    ];
    const xml = buildSitemap(pages, { origin: ORIGIN, defaultLocale: 'en', locales: ['en'] });
    assert.match(xml, /<lastmod>2026-08-05<\/lastmod>/);
    assert.match(xml, /<lastmod>2026-06-01<\/lastmod>/);
});

// ── meta budgets ─────────────────────────────────────────────────────

test('the server clamp equals the editor counters — one truth for title/description budgets', () => {
    // SeoSection.jsx counts against 60/155; a wider server clamp would let a
    // title survive the editor and still be cut in the served HTML.
    const { TITLE_MAX, DESC_MAX } = require('./head');
    assert.strictEqual(TITLE_MAX, 60);
    assert.strictEqual(DESC_MAX, 155);
});

test('the pre-hydration view is laid out, and is not hidden', () => {
    // It is on screen only between first paint and React mounting, but a
    // visitor cannot tell a deliberate plain view from a stylesheet that
    // failed to load — so it gets the real container and rhythm.
    const html = renderBlocks([{ type: 'hero', content: { title: 'T', lead: 'L' } }]);
    assert.match(html, /class="marketing-root cms-prehydrate"/);
    assert.match(html, /class="container"/);

    // Hiding server-rendered text from users while serving it to crawlers is
    // cloaking. That it would also hide the flash is not a reason to do it.
    // `animation` is in this list since the delay removal: an entrance
    // animation with `both` fill IS opacity:0 for its delay, and the old
    // 450ms delay was the page's mobile FCP — server text paints immediately.
    for (const trick of ['display:none', 'display: none', 'visibility:hidden',
        'visibility: hidden', 'opacity:0', 'position:absolute', 'text-indent',
        'animation']) {
        assert.ok(!PREHYDRATE_CSS.includes(trick), `pre-hydration CSS must not use ${trick}`);
    }
    assert.ok(!html.includes('hidden'), 'the markup itself must not be hidden either');
});
