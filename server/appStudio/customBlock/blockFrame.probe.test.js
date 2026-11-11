'use strict';

/**
 * custom_block: does anything a block holds reach the network?
 *
 * A real browser, a real listener. Skipped unless APP_CSS_TEST_CHROME names a Chrome or
 * Chromium binary (there is none in CI):
 *   APP_CSS_TEST_CHROME=/usr/bin/google-chrome-stable node --test appStudio/customBlock/blockFrame.probe.test.js
 *
 * The page under test is built by the code the product runs: the web runtime's
 * blockPipeline.ts (bundled here with the server's esbuild) builds each frame document in
 * the browser, with the browser's own DOMParser, and the frame is the same
 * `<iframe sandbox=… srcdoc=…>`. Every hostile template gets its own frame and its own host
 * name (`v-<name>-<surface>-<path>.block-probe.test`, mapped to this machine), so anything
 * that arrives says which template sent it.
 *
 * Four surfaces (how the host page is loaded and whether controls are wired):
 *   run         a page of the app's origin, with a session cookie, events wired
 *   edit        the same origin, no event handed to the frame (the editor canvas)
 *   public      another origin without a cookie and without any policy of its own, events wired
 *   screenshot  a page set from text (no origin of its own), as the headless render does
 * Two paths per surface:
 *   saved       the block went through the server's cleaner first (cleanCustomBlock)
 *   raw         the block as written: an import or a draft that never passed the server
 *
 * What counts as "arrived": an HTTP request at the listener for anything but the host page
 * and the control image, a UDP packet, or ANY mention of a hostile host name in Chrome's own
 * network log (a DNS lookup, a preconnect, a socket, a request). The control image, loaded by
 * the host page itself, must arrive: it shows the listener and the name mapping work.
 *
 * One more page is there to show what the probe can see, and is reported, not asserted (it
 * rests on what today's Chrome does): a frame with the SAME sandbox and policy whose document
 * was not built by the pipeline and holds a bare <link rel="prerender">. That request leaves.
 * So the frame and its policy alone do not keep a block from the network: the vocabulary does,
 * by never writing a <link> (or any other element or attribute that names an address).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dgram = require('node:dgram');

const { cleanCustomBlock } = require('./blockShape.mts');
const { FRAME_SANDBOX, buildFrameDocument, escapeAttr } = require('../../shared/blockTemplate/index.mjs');

const chrome = process.env.APP_CSS_TEST_CHROME;
const AGENT_HUB = path.resolve(__dirname, '../../../agent-hub/src');
const PIPELINE = path.join(AGENT_HUB, 'components/admin/Studio/AppStudio/runtime/components/customBlock/blockPipeline.ts');
const ZONE = 'block-probe.test';
const SURFACES = ['run', 'edit', 'public', 'screenshot'];
const PATHS = ['saved', 'raw'];

/** The hostile templates. `U` is the address each one tries to reach, `S` a same-origin path. */
function vectors(U, S) {
    const run = `parent.__ran=(parent.__ran||0)+1;top.__ran=1;new Image().src='${U}/script'`;
    return {
        script: { template: `<script>${run}</script><p onclick="${run}" onmouseover="${run}">a</p><svg onload="${run}"><script>${run}</script></svg><a href="javascript:${run}">j</a><button onclick="${run}" formaction="javascript:${run}">b</button><details ontoggle="${run}" open><summary>s</summary></details>` },
        linkPrerender: { template: `<link rel="prerender" href="${U}/prerender"><link rel="prefetch" href="${U}/prefetch"><link rel="next" href="${U}/next">` },
        linkPreload: { template: `<link rel="preload" as="image" href="${U}/preload"><link rel="modulepreload" href="${U}/modulepreload"><link rel="preload" as="style" href="${U}/preload.css">` },
        linkDns: { template: `<link rel="dns-prefetch" href="${U}/"><link rel="preconnect" href="${U}/">` },
        linkStylesheet: { template: `<link rel="stylesheet" href="${U}/sheet.css"><link rel="icon" href="${U}/icon.png"><link rel="manifest" href="${U}/manifest.json">` },
        metaRefresh: { template: `<meta http-equiv="refresh" content="0;url=${U}/refresh"><meta http-equiv="refresh" content="0;url=${S}/refresh">` },
        img: { template: `<img src="${U}/img.png"><img srcset="${U}/srcset.png 1x, ${U}/srcset2.png 2x"><picture><source srcset="${U}/source.png"><img></picture><img src="${S}/img.png"><img data-image="x" src="${U}/named.png">` },
        cssUrl: {
            template: `<style>@import url(${U}/import.css); body{background:url(${U}/style.png)}</style><p style="background:url(${U}/inline.png)">a</p><p style="background-image:image-set('${U}/imageset.png' 1x)">b</p><p style="list-style-image:url(${U}/list.png);content:url(${U}/content.png);cursor:url(${U}/cursor.png),auto">c</p><p style="background:u\\72l(${U}/escaped.png)">d</p>`,
            css: `@import url(${U}/css-import.css); @import '${U}/css-import2.css'; @font-face{font-family:x;src:url(${U}/font.woff2)} @namespace url(${U}/ns);`
                + ` p{font-family:x;background:url(${U}/css-bg.png)} div{background-image:image-set("${U}/css-imageset.png" 1x)}`
                + ` span{background:u\\72l(${U}/css-escaped.png)} b{border-image:url(${U}/css-border.png) 1;mask:url(${U}/css-mask.svg#m);filter:url(${U}/css-filter.svg#f)}`
                + ` i{cursor:url(${U}/css-cursor.png),auto;list-style:url(${U}/css-list.png);content:url(${U}/css-content.png)} u{background:-webkit-image-set(url(${U}/css-wis.png) 1x);background:image("${U}/css-image.png")}`
                + ` s{background:url(${S}/css-same.png)} </style><img src="${U}/css-break.png"><style>`,
        },
        aPing: { template: `<a href="${U}/href" ping="${U}/ping" target="_top">a</a><a href="#x" ping="${U}/ping2">b</a><a href="${S}/href">c</a><area href="${U}/area" ping="${U}/areaping">` },
        form: { template: `<form action="${U}/form" method="post"><input type="submit" value="s"><button>go</button><button formaction="${U}/formaction">f</button><input type="image" src="${U}/inputimage.png"></form><button form="x" formaction="${U}/fa2">g</button>` },
        svg: { template: `<svg><use href="${U}/use.svg#a"/><use xlink:href="${U}/xuse.svg#a"/><image href="${U}/svgimage.png"/><image xlink:href="${U}/xsvgimage.png"/><filter id="f"><feImage href="${U}/feimage.png"/></filter><rect filter="url(#f)" fill="url(${U}/paint.svg#p)" width="10" height="10"/><a href="${U}/svga"><text>t</text></a><foreignObject><img src="${U}/fo.png"></foreignObject><style>@import '${U}/svgstyle.css';</style><animate attributeName="href" to="${U}/animate"/><set attributeName="href" to="${U}/set"/><path style="fill:url(${U}/pathstyle.svg#p)" d="M0 0"/></svg>` },
        objectEmbed: { template: `<object data="${U}/object"></object><embed src="${U}/embed"><applet code="${U}/applet"></applet>` },
        frames: { template: `<iframe src="${U}/iframe"></iframe><iframe srcdoc="<img src='${U}/nested.png'><link rel=prerender href='${U}/nestedprerender'>"></iframe><frame src="${U}/frame"><portal src="${U}/portal"></portal>` },
        base: { template: `<base href="${U}/base/"><img src="rel.png"><a href="rel">r</a>` },
        media: { template: `<video poster="${U}/poster.png" src="${U}/video.mp4" autoplay></video><audio src="${U}/audio.mp3" autoplay></audio><video><source src="${U}/source.mp4"><track src="${U}/track.vtt" default></video>` },
        background: { template: `<table background="${U}/tablebg.png"><tr><td background="${U}/tdbg.png">x</td></tr></table><div background="${U}/divbg.png">y</div>` },
        bodyBackground: { template: `</p></div></body><body background="${U}/bodybg.png"><html manifest="${U}/manifest"><head profile="${U}/profile">` },
        malformed: {
            template: `<p title="a"href="${U}/glued">a</p><img/src="${U}/slash.png"><img src=${U}/unquoted.png><svg><p><link rel=prerender href=${U}/svgbreak></p></svg>`
                + `<math><mtext><link rel=prerender href="${U}/math"></mtext><annotation-xml encoding="text/html"><link rel=prerender href="${U}/annotation"></annotation-xml></math>`
                + `<noscript><p title="</noscript><link rel=prerender href=${U}/noscript>"></noscript><textarea></textarea><link rel=prerender href="${U}/textarea"><title></title><link rel=prerender href="${U}/title">`
                + `<template><link rel=prerender href="${U}/template"></template><!--><link rel=prerender href="${U}/comment1">--><!----!><link rel=prerender href="${U}/comment2">-->`
                + `<p <link rel=prerender href="${U}/intag">>x</p><p title='"><link rel=prerender href="${U}/quote">'>y</p><p title="{{ "x" }}"><link rel=prerender href="${U}/formulaquote">">z</p>`
                + `<xmp><link rel=prerender href="${U}/xmp"></xmp><plaintext><link rel=prerender href="${U}/plaintext">`,
        },
        entities: { template: `&lt;link rel=prerender href="${U}/entity"&gt;&#60;link rel=prerender href="${U}/numeric"&#62;<p title="&quot;&gt;&lt;link rel=prerender href=${U}/attr-entity&gt;">e</p>{{ "<link rel=prerender href=${U}/formula>" }}` },
        values: {
            template: '<p class="{{ v }}" title="{{ v }}" data-state="{{ v }}" aria-label="{{ v }}">{{ v }}</p><ul><li data-each="list">{{ item }}</li></ul><svg><rect x="{{ v }}" fill="{{ v }}" width="4" height="4"></rect><path d="{{ v }}"></path></svg><button data-emit="pick" data-value="v">{{ v }}</button>',
            inputs: {
                v: { kind: 'static', value: `"><link rel=prerender href="${U}/value"><img src="${U}/value.png"><script>${run}</script>` },
                list: { kind: 'static', value: [`<link rel=prerender href="${U}/listvalue">`, `url(${U}/listurl)`] },
            },
        },
        theme: { template: '<p>themed</p>', theme: { primary: `red;}</style><link rel=prerender href="${U}/theme"><style>`, font: `x;background:url(${U}/themefont.png)`, 'bad;key': `url(${U}/themekey.png)` }, lang: `en"><link rel=prerender href="${U}/lang">` },
        // Nothing hostile: a block of the kind people write, with a wired control. It must draw.
        honest: { template: '<div class="card"><h3>{{ title }}</h3><ul><li data-each="rows as r" data-if="r.open">{{ r.name }}</li></ul><button data-emit="pick" data-value="title">Open</button><svg viewBox="0 0 10 10" width="20" height="20"><circle cx="5" cy="5" r="{{ 2 + 2 }}" fill="currentColor"></circle></svg></div>', css: '.card{padding:8px;border:1px solid var(--bf-border)}', inputs: { title: { kind: 'static', value: 'Honest' }, rows: { kind: 'static', value: [{ name: 'Ada', open: true }, { name: 'Bo', open: false }] } } },
    };
}

/** The hostile blocks of one surface and path, each with its own host name. */
function blocksFor(surface, entry, port, hostOrigin) {
    const out = {};
    for (const name of Object.keys(vectors('', ''))) {
        const host = `v-${name.toLowerCase()}-${surface}-${entry}.${ZONE}`;
        const v = vectors(`http://${host}:${port}`, `${hostOrigin}/same-origin/${name}-${surface}-${entry}`)[name];
        let block = { template: v.template, css: v.css, inputs: v.inputs, events: { pick: 'act_pick' } };
        if (entry === 'saved') block = cleanCustomBlock(block, () => {}, 'block') || { template: '' };
        out[name] = { block, theme: v.theme || { primary: '#2563eb' }, lang: v.lang || 'en' };
    }
    return out;
}

/** JSON that can sit inside a <script> element. */
const inlineJson = (value) => JSON.stringify(value).split('<').join('\\u003c');

function hostPage({ surface, blocks, bundle, control }) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${surface}</title></head><body>
<img id="control" src="${control}" alt="">
<div id="frames"></div>
<script>${bundle}</script>
<script>
window.__ran = 0; window.__actions = []; window.__built = {};
const blocks = ${inlineJson(blocks)};
const wired = ${surface === 'edit' ? '[]' : '["pick"]'};
for (const [name, entry] of Object.entries(blocks)) {
    const scope = {};
    for (const [key, binding] of Object.entries(entry.block.inputs || {})) scope[key] = binding && binding.kind === 'static' ? binding.value : null;
    const built = BlockPipeline.buildBlockFrame({ block: entry.block, scope, events: wired, theme: entry.theme, dark: false, lang: entry.lang });
    window.__built[name] = { emits: built.emits.length, findings: built.findings.length, empty: built.empty };
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', ${JSON.stringify(FRAME_SANDBOX)});
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.dataset.vector = name;
    frame.style.cssText = 'display:block;width:600px;height:120px';
    frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        if (!doc) return;
        doc.addEventListener('click', (event) => {
            const control = event.target && event.target.closest ? event.target.closest('[data-bf-emit]') : null;
            if (control) window.__actions.push(name + ':' + control.getAttribute('data-bf-emit'));
        });
    });
    frame.srcdoc = built.doc;
    document.getElementById('frames').appendChild(frame);
}
</script></body></html>`;
}

/** What the host page can see of its frames once they are loaded: forbidden nodes, and whether the frame is still the block. */
const INSPECT = `(() => {
    const forbidden = 'script,link,base,iframe,frame,object,embed,applet,form,input,textarea,select,img,picture,source,video,audio,track,template,use,image,feImage,foreignObject,animate,set,math,portal,area,noscript';
    const out = {};
    for (const frame of document.querySelectorAll('iframe')) {
        const doc = frame.contentDocument;
        const body = doc && doc.body;
        const all = body ? [...body.querySelectorAll('*')] : [];
        out[frame.dataset.vector] = {
            location: doc ? doc.location.href : null,
            forbidden: body ? [...body.querySelectorAll(forbidden)].map((el) => el.localName) : ['unreadable'],
            headExtras: doc ? [...doc.head.children].filter((el) => !(el.localName === 'meta' || el.localName === 'style')).map((el) => el.localName) : [],
            metas: doc ? [...doc.head.querySelectorAll('meta')].map((el) => el.getAttribute('http-equiv') || el.getAttribute('name') || el.getAttribute('charset') && 'charset') : [],
            handlers: all.flatMap((el) => [...el.attributes].map((a) => a.name)).filter((n) => n.startsWith('on')),
            addresses: all.flatMap((el) => [...el.attributes].filter((a) => ['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'ping', 'poster', 'background', 'data', 'srcdoc', 'manifest', 'profile', 'code'].includes(a.name)).map((a) => el.localName + '.' + a.name)),
            text: body ? body.textContent.slice(0, 60) : '',
            height: body ? body.getBoundingClientRect().height : 0,
        };
    }
    return { frames: out, ran: window.__ran, actions: window.__actions, built: window.__built };
})()`;

async function bundlePipeline() {
    const esbuild = require('esbuild');
    const result = await esbuild.build({
        entryPoints: [PIPELINE],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'BlockPipeline',
        platform: 'browser',
        target: 'chrome120',
        logLevel: 'silent',
        alias: { '@shared': path.join(AGENT_HUB, 'shared'), '@': AGENT_HUB },
    });
    return result.outputFiles[0].text.split('</script').join('<\\/script');
}

function listen() {
    const hits = [];
    const pages = new Map();
    const server = http.createServer((req, res) => {
        const url = String(req.url);
        if (pages.has(url)) {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            if (url.startsWith('/app/')) res.setHeader('set-cookie', 'sid=session-of-the-viewer; Path=/; SameSite=Lax');
            res.end(pages.get(url));
            return;
        }
        hits.push({ host: String(req.headers.host), url, cookie: String(req.headers.cookie || '') });
        res.end('');
    });
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => { packets += 1; });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            udp.bind(0, '127.0.0.1', () => resolve({ server, udp, hits, pages, port: server.address().port, packets: () => packets }));
        });
    });
}

test('nothing a custom block holds reaches the network, on any surface', { skip: chrome ? false : 'set APP_CSS_TEST_CHROME to run', timeout: 180000 }, async (t) => {
    const { chromium } = require('playwright-core');
    const bundle = await bundlePipeline();
    const net = await listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-probe-'));
    const netlog = path.join(dir, 'netlog.json');
    const browser = await chromium.launch({ executablePath: chrome, headless: true, args: [`--log-net-log=${netlog}`, `--host-resolver-rules=MAP *.${ZONE} 127.0.0.1`] });
    const appOrigin = `http://app.${ZONE}:${net.port}`;
    const publicOrigin = `http://public.${ZONE}:${net.port}`;
    const seen = {};
    let bareLink = 'not run';
    try {
        // What the frame alone lets through (reported below, see the header).
        const bare = await browser.newPage();
        net.pages.set('/app/bare', `<!doctype html><body><iframe sandbox="${FRAME_SANDBOX}" srcdoc="${escapeAttr(buildFrameDocument({ body: `<link rel="prerender" href="http://bare-link.${ZONE}:${net.port}/bare">`, css: '' }))}"></iframe></body>`);
        await bare.goto(`${appOrigin}/app/bare`, { waitUntil: 'load' });
        await bare.waitForTimeout(1200);
        await bare.close();
        bareLink = net.hits.some((hit) => hit.url === '/bare') ? 'ARRIVED' : 'did not arrive';

        for (const surface of SURFACES) {
            for (const entry of PATHS) {
                const origin = surface === 'public' ? publicOrigin : appOrigin;
                const control = `http://control.${ZONE}:${net.port}/control/${surface}-${entry}`;
                const html = hostPage({ surface, blocks: blocksFor(surface, entry, net.port, origin), bundle, control });
                const page = await browser.newPage();
                if (surface === 'screenshot') {
                    await page.setContent(html, { waitUntil: 'load' });
                } else {
                    const route = `/${surface === 'public' ? 'p' : 'app'}/${surface}-${entry}`;
                    net.pages.set(route, html);
                    await page.goto(`${origin}${route}`, { waitUntil: 'load' });
                }
                await page.waitForTimeout(600);
                // Press everything a visitor could press inside every block.
                for (const frame of page.frames().slice(1)) {
                    const controls = await frame.locator('a, button, summary, input, area').all().catch(() => []);
                    for (const control of controls) await control.click({ timeout: 300, force: true }).catch(() => {});
                }
                await page.waitForTimeout(600);
                seen[`${surface}-${entry}`] = await page.evaluate(INSPECT);
                await page.close();
            }
        }
    } finally {
        await browser.close();
        net.server.close();
        net.udp.close();
    }

    // The listener works: every host page's own control image arrived, and only those.
    const controls = net.hits.filter((hit) => hit.url.startsWith('/control/')).map((hit) => hit.url).sort();
    assert.deepEqual(controls, SURFACES.flatMap((s) => PATHS.map((p) => `/control/${s}-${p}`)).sort(), 'the control image of every page arrives');
    const arrived = net.hits.filter((hit) => !hit.url.startsWith('/control/') && hit.url !== '/favicon.ico' && hit.url !== '/bare');
    assert.deepEqual(arrived, [], 'no request from a block arrives');
    assert.equal(net.packets(), 0, 'no UDP packet arrives');

    // Chrome's own network log names no hostile host: no lookup, no preconnect, no socket, no request.
    const log = fs.readFileSync(netlog, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(log.includes(`control.${ZONE}`), 'the network log holds the control request');
    const named = new Set();
    let at = log.indexOf(`.${ZONE}`);
    while (at !== -1) {
        let start = at;
        while (start > 0 && 'abcdefghijklmnopqrstuvwxyz0123456789-'.includes(log[start - 1])) start -= 1;
        named.add(log.slice(start, at));
        at = log.indexOf(`.${ZONE}`, at + 1);
    }
    assert.deepEqual([...named].filter((name) => name.startsWith('v-')), [], 'the network log names no host of a hostile template');

    for (const [where, result] of Object.entries(seen)) {
        assert.equal(result.ran, 0, `${where}: no script of a block ran`);
        for (const [name, frame] of Object.entries(result.frames)) {
            assert.equal(frame.location, 'about:srcdoc', `${where} ${name}: the frame still shows the block`);
            assert.deepEqual(frame.forbidden, [], `${where} ${name}: no element outside the vocabulary`);
            assert.deepEqual(frame.headExtras, [], `${where} ${name}: the head holds the host's meta and style only`);
            assert.deepEqual(frame.metas, ['charset', 'Content-Security-Policy', 'referrer'], `${where} ${name}: the head's metas are the host's`);
            assert.deepEqual(frame.handlers, [], `${where} ${name}: no event-handler attribute`);
            assert.deepEqual(frame.addresses, [], `${where} ${name}: no attribute that holds an address`);
        }
        // The honest block drew, and its control answers the host on every surface but the editor.
        assert.ok(result.frames.honest.text.startsWith('HonestAda'), `${where}: the honest block is drawn (${result.frames.honest.text})`);
        assert.ok(result.frames.honest.height > 20 && result.frames.honest.height < 400, `${where}: the host can measure the block (${result.frames.honest.height})`);
        const pressed = result.actions.filter((a) => a.startsWith('honest:'));
        assert.deepEqual(pressed, where.startsWith('edit') ? [] : ['honest:0'], `${where}: the wired control of the honest block`);
        assert.ok(result.built.script.findings > 0 || where.endsWith('saved'), `${where}: the raw path reports what it left out`);
    }
    t.diagnostic(`surfaces × paths: ${Object.keys(seen).join(', ')}; templates per page: ${Object.keys(seen['run-raw'].frames).length}; requests from a block: ${arrived.length}`);
    t.diagnostic(`outside the pipeline: a bare <link rel="prerender"> written straight into a frame with the same sandbox and policy ${bareLink}`);
});
