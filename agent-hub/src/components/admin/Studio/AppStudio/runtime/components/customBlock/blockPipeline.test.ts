import { describe, expect, it } from 'vitest';
import { FRAME_CSP, FRAME_SANDBOX } from '@shared/blockTemplate/index.mjs';
import { buildBlockFrame } from './blockPipeline';

const frameOf = (block: Record<string, unknown>, scope: Record<string, unknown> = {}, events: string[] = []) =>
    buildBlockFrame({ block, scope, events, theme: { primary: '#2563eb' }, dark: false, lang: 'en' });

/** The body of a frame document, the part an author's template can reach. */
const bodyOf = (doc: string) => doc.slice(doc.indexOf('<body>') + '<body>'.length, doc.lastIndexOf('</body>'));

const X = 'http://leak.example/x';

/** Hostile templates: each asks for an address or tries to run something. */
const HOSTILE: Record<string, string> = {
    script: `<script>new Image().src='${X}'</script><p onclick="fetch('${X}')">a</p><svg onload="fetch('${X}')"></svg>`,
    links: `<link rel="prerender" href="${X}"><link rel="preload" as="image" href="${X}"><link rel="dns-prefetch" href="${X}"><link rel="preconnect" href="${X}"><link rel="stylesheet" href="${X}">`,
    meta: `<meta http-equiv="refresh" content="0;url=${X}"><base href="${X}">`,
    images: `<img src="${X}"><img srcset="${X} 1x"><picture><source srcset="${X}"></picture><input type="image" src="${X}">`,
    style: `<style>@import url(${X}); body{background:url(${X})}</style><p style="background:url(${X})">a</p><p style="background-image:image-set('${X}' 1x)">b</p>`,
    anchors: `<a href="${X}" ping="${X}">a</a><a href="javascript:fetch('${X}')">b</a><form action="${X}"><button formaction="${X}">c</button></form>`,
    svg: `<svg><use href="${X}#a"/><image href="${X}"/><filter id="f"><feImage href="${X}"/></filter><rect fill="url(${X}#p)" filter="url(#f)"/><a href="${X}"><text>t</text></a><foreignObject><img src="${X}"></foreignObject><style>@import '${X}';</style><script href="${X}"/></svg>`,
    embeds: `<object data="${X}"></object><embed src="${X}"><iframe src="${X}"></iframe><iframe srcdoc="<img src='${X}'>"></iframe>`,
    media: `<video poster="${X}" src="${X}"></video><audio src="${X}" autoplay></audio><track src="${X}">`,
    backgrounds: `<table background="${X}"><tr><td background="${X}">a</td></tr></table><body background="${X}">`,
    malformed: `<p title="a"href="${X}">a</p><img/src="${X}"><svg><p><link rel=prerender href=${X}></p></svg><math><mtext><link rel=prerender href="${X}"></mtext></math><noscript><p title="</noscript><img src=${X}>"></noscript><textarea></textarea><link rel=prerender href="${X}"><template><link rel=prerender href="${X}"></template><!--><link rel=prerender href="${X}">--><p <link rel=prerender href="${X}">>x</p>`,
};

describe('a custom block frame document', () => {
    it('carries its policy and the theme, and no script', () => {
        const { doc } = frameOf({ template: '<p>Hello</p>', css: 'p{color:var(--bf-primary)}' });
        expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`);
        expect(doc).toContain('--bf-primary:#2563eb;');
        expect(doc).toContain('<p>Hello</p>');
        expect(doc).toContain('p{color:var(--bf-primary)}');
        expect(doc.toLowerCase()).not.toContain('<script');
        expect(FRAME_SANDBOX).toBe('allow-same-origin');
        expect(FRAME_CSP).not.toContain('script');
    });

    it.each(Object.entries(HOSTILE))('holds no address and nothing that runs: %s', (_name, template) => {
        const { doc, findings } = frameOf({ template, css: `@import url(${X}); p{background:url(${X});color:red}` });
        const lower = doc.toLowerCase();
        expect(lower).not.toContain('leak.example');
        expect(lower).not.toContain('javascript:');
        for (const tag of ['<script', '<link', '<base', '<iframe', '<object', '<embed', '<form', '<input', '<img', '<video', '<audio', '<use', '<image', '<feimage', '<foreignobject', '<template', '<math']) {
            expect(lower, tag).not.toContain(tag);
        }
        // The one <meta> and <style> pair is the host's own, in the head.
        const body = bodyOf(lower);
        for (const tag of ['<meta', '<style', ' on', 'href', 'src']) expect(body, tag).not.toContain(tag);
        expect(findings.length).toBeGreaterThan(0);
    });

    it('writes a value as text, never as markup, wherever it lands', () => {
        const hostile = `"><img src=${X} onerror=alert(1)><script>x</script>`;
        const { doc } = frameOf({
            template: '<p class="a {{ v }}" title="{{ v }}" data-state="{{ v }}" aria-label="{{ v }}">{{ v }}</p><svg><rect x="{{ v }}" fill="{{ v }}"></rect></svg>',
        }, { v: hostile });
        const body = bodyOf(doc);
        expect(body).not.toContain('<img');
        expect(body).not.toContain('<script');
        expect(body).toContain('&lt;img src=');
        // A class is held to class names, an svg value to its characters: the rest is dropped.
        expect(body).toContain('<p class="a"');
        expect(body).toContain('<rect></rect>');
    });

    it('repeats, tests conditions and numbers the wired controls', () => {
        const block = {
            template: '<ul><li data-each="rows as r" data-if="r.open">{{ index }}:{{ r.name }} <button data-emit="pick" data-value="r.id">Open</button><button data-emit="other">No</button></li></ul>',
        };
        const scope = { rows: [{ id: 1, name: 'Ada', open: true }, { id: 2, name: 'Bo', open: false }, { id: 3, name: 'Cy', open: true }] };
        const run = frameOf(block, scope, ['pick']);
        expect(bodyOf(run.doc)).toBe('<ul><li>0:Ada <button type="button" data-bf-emit="0">Open</button><button type="button">No</button></li><li>2:Cy <button type="button" data-bf-emit="1">Open</button><button type="button">No</button></li></ul>');
        expect(run.emits).toEqual([{ event: 'pick', value: 1 }, { event: 'pick', value: 3 }]);
        // Without an event handed in (the editor), no control is numbered.
        const edit = frameOf(block, scope, []);
        expect(edit.doc).not.toContain('data-bf-emit');
        expect(edit.emits).toEqual([]);
    });

    it('reports a formula that fails and draws nothing for it', () => {
        const { doc, problems } = frameOf({ template: '<p>a{{ nope( }}b{{ missing.deep }}c</p>' });
        expect(bodyOf(doc)).toBe('<p>abc</p>');
        expect(problems.length).toBe(1);
    });

    it('an empty or missing template is empty', () => {
        expect(frameOf({}).empty).toBe(true);
        expect(frameOf({ template: '<script>x</script>' }).empty).toBe(true);
    });
});
