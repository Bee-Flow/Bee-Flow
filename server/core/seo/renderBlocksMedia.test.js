// @typecheck noImplicitAny
const test = require('node:test');
const assert = require('node:assert');
const { renderBlocks } = require('./renderBlocks');

const block = (/** @type {Record<string, unknown>} */ content, type = 'feature') => ({ id: 'b1', type, content });

test('block media becomes an <img> with its alt text and a resolved asset URL', () => {
    const html = renderBlocks([block({
        title: 'Editor',
        media: { kind: 'image', src: 'cms/shots/editor one.png', alt: 'The assistant editor', srcDark: '', frame: 'hairline' },
    })]);
    assert.match(html, /<img src="\/api\/cms\/asset\/cms\/shots\/editor%20one\.png" srcset="[^"]+" sizes="[^"]+" alt="The assistant editor" loading="eager" fetchpriority="high" decoding="async">/);
});

test('an image without alt text is rendered decorative (alt="") rather than skipped', () => {
    const html = renderBlocks([block({ media: { kind: 'image', src: '/img/a.png', alt: '' } })]);
    assert.match(html, /<img src="\/img\/a\.png" alt="" loading="eager" fetchpriority="high" decoding="async">/);
});

test('empty, non-image and script-scheme sources are not rendered', () => {
    const html = renderBlocks([block({ items: [
        { media: { kind: 'image', src: '', alt: 'x' } },
        { media: { kind: 'video', src: 'cms/v.mp4', alt: 'v' } },
        { media: { kind: 'image', src: 'javascript:alert(1)', alt: 'bad' } },
    ] })]);
    assert.ok(!html.includes('<img'), html);
});

test('alt text is escaped', () => {
    const html = renderBlocks([block({ media: { kind: 'image', src: '/a.png', alt: '"><script>x</script>' } })]);
    assert.ok(!html.includes('<script>'));
});

test('a card with text and a link keeps its text and gets a real anchor', () => {
    const html = renderBlocks([block({ items: [
        { title: 'Notebooks', body: 'Draft from sources.', link: { href: '/notebooks' } },
    ] })]);
    assert.match(html, /<a href="\/notebooks">Notebooks<\/a>/);
    assert.match(html, /Draft from sources\./);
});

test('a card link without a label falls back to its title; external and anchor links are left out', () => {
    const html = renderBlocks([block({ items: [
        { title: 'Outside', body: 'x', link: { href: 'https://example.com', target: '_blank' } },
        { title: 'Jump', body: 'y', link: { href: '#faq' } },
        { title: 'Legal', sublabel: 'Sub-processors', href: '/subprocessors' },
    ] })]);
    assert.ok(!html.includes('example.com'));
    assert.ok(!html.includes('#faq'));
    assert.match(html, /<a href="\/subprocessors">Legal<\/a>/);
});

test('site chrome links (header nav groups, footer) are listed once each as navigation', () => {
    const header = { nav: [{ label: 'Product', link: { href: '/platform' }, groups: [{ items: [
        { label: 'Assistants', link: { href: '/assistants' }, description: 'Build one' },
        { label: 'Assistants again', link: { href: '/assistants' } },
        { label: 'Docs', link: { href: 'https://docs.example.com' } },
    ] }] }] };
    const footer = { columns: [{ title: 'Legal', links: [{ label: 'Imprint', link: { href: '/imprint' } }] }] };
    const html = renderBlocks([block({ title: 'Hello' })], { chrome: { header, footer } });
    assert.match(html, /<nav aria-label="Site">/);
    assert.match(html, /<a href="\/platform">Product<\/a>/);
    assert.match(html, /<a href="\/assistants">Assistants<\/a>/);
    assert.strictEqual((html.match(/href="\/assistants"/g) || []).length, 1);
    assert.match(html, /<a href="\/imprint">Imprint<\/a>/);
    assert.ok(!html.includes('docs.example.com'));
});

test('disabled chrome (a whole footer, a group or an item) contributes no links', () => {
    const header = { nav: [{ label: 'Off', enabled: false, link: { href: '/off' }, groups: [{ items: [{ label: 'Child', link: { href: '/child' } }] }] }] };
    const footer = { enabled: false, columns: [{ links: [{ label: 'Imprint', link: { href: '/imprint' } }] }] };
    const html = renderBlocks([block({ title: 'Hello' })], { chrome: { header, footer } });
    assert.ok(!html.includes('/off') && !html.includes('/child') && !html.includes('/imprint'), html);
});

test('a page without blocks and without chrome still renders nothing', () => {
    assert.strictEqual(renderBlocks([]), '');
});

test('an image with stored dimensions carries width and height; bad values are dropped', () => {
    const html = renderBlocks([block({ items: [
        { media: { kind: 'image', src: '/a.png', alt: 'a', width: 1200, height: 630 } },
        { media: { kind: 'image', src: '/b.png', alt: 'b', width: '12"x', height: -4 } },
    ] })]);
    assert.match(html, /<img src="\/a\.png" alt="a" width="1200" height="630" loading="eager" fetchpriority="high" decoding="async">/);
    assert.match(html, /<img src="\/b\.png" alt="b" loading="lazy">/);
});

test('a product mockup gives the crawler its prompt and every step, not only what the animation shows', () => {
    const html = renderBlocks([block({
        title: 'See it work',
        prompt: 'Summarise my inbox <daily>',
        steps: [{ role: 'assistant', text: 'Which mailbox?' }, { role: 'card', title: 'Morning summary', text: 'Runs at 08:00' }],
    }, 'product-mockup')]);
    assert.match(html, /<p>Summarise my inbox &lt;daily&gt;<\/p>/);
    assert.match(html, /Which mailbox\?/);
    assert.match(html, /Morning summary/);
    assert.doesNotMatch(html, /assistant|card/);
});
