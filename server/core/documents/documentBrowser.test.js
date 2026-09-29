'use strict';
/* global window, document */
// Opt-in real Chromium coverage: DOCUMENT_BROWSER=/path/to/chrome node --test this-file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeDocument } = require('../../services/documentCompose');
const { prepareDocument } = require('./documentContract');
const { starters } = require('./documentStarters');
const browserPath = process.env.DOCUMENT_BROWSER;
async function readPdf(data) {
    const parser = new (require('pdf-parse').PDFParse)({data});
    try { return await parser.getText(); } finally { await parser.destroy(); }
}

test('real browser: conditional customer PDF, long tables, and immediate edit flush', {skip:!browserPath}, async () => {
    const browser = await require('playwright').chromium.launch({executablePath:browserPath,headless:true,args:['--no-sandbox']});
    try {
        const page = await browser.newPage();
        const errors=[]; page.on('pageerror',e=>errors.push(e.message));
        const security = starters().find(s=>s.id==='security');
        const fill = prepareDocument(security,{'customer.name':'Customer B',date:'2026-09-17',summary:'Office environment',remoteAccess:false,cloudServices:false});
        assert.equal(fill.valid,true);
        await page.setContent(composeDocument({...security,bodyHtml:fill.bodyHtml}));
        assert.equal(await page.locator('[data-doc-section="remote"]').count(),0);
        const pdf = await page.pdf({preferCSSPageSize:true,printBackground:true});
        assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
        const customerB = await readPdf(pdf);
        assert.match(customerB.text,/Customer B/);
        assert.doesNotMatch(customerB.text,/Remote access|Cloud services/);
        const included = prepareDocument(security,{'customer.name':'Customer A',date:'2026-09-17',summary:'Verified environment',remoteAccess:true,cloudServices:true,remoteControls:'VPN and MFA',cloudControls:'Restricted cloud roles'});
        await page.setContent(composeDocument({...security,bodyHtml:included.bodyHtml}));
        const customerA = await readPdf(await page.pdf({preferCSSPageSize:true,printBackground:true}));
        assert.match(customerA.text,/VPN and MFA/);assert.match(customerA.text,/Restricted cloud roles/);
        const invoice = starters().find(s=>s.id==='invoice');
        const long = prepareDocument(invoice,{'customer.name':'Long invoice',date:'2026-09-17',summary:'Many rows',lines:Array.from({length:100},(_,i)=>({description:`Service ${i+1}`,amount:i})),total:4950});
        assert.equal(long.valid,true);
        await page.setContent(composeDocument({...invoice,bodyHtml:long.bodyHtml}));
        assert.equal(await page.locator('tbody tr').count(),100);
        const longPdf=await page.pdf({preferCSSPageSize:true,printBackground:true});
        assert.ok(longPdf.length>pdf.length);
        const longText = await readPdf(longPdf);
        assert.ok(longText.total > 1, 'long tables span multiple pages');
        assert.match(longText.text,/Service 100/);
        // Page size, embedded logos and explicit page breaks use the same CSS
        // in previews and the browser PDF renderer.
        const logo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
        await page.setContent(composeDocument({bodyHtml:`<img class="doc-logo" src="${logo}" alt="Company logo"><p>First page</p><p style="break-before:page">Second page</p>`,settings:{design:{pageSize:'Letter',margin:20,logoPosition:'right'}}}));
        assert.equal(await page.locator('img').evaluate(el=>el.complete && el.naturalWidth>0),true);
        const pages=await readPdf(await page.pdf({preferCSSPageSize:true,printBackground:true}));
        assert.equal(pages.total,2);assert.match(pages.text,/Second page/);
        // Frame -> parent round-trip uses the real bridge, including protected tokens.
        await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:800px"></iframe>');
        await page.evaluate(html=>{
            window.messages=[];
            window.addEventListener('message',e=>window.messages.push(e.data));
            document.querySelector('iframe').srcdoc=html;
        },composeDocument({bodyHtml:'<p>Hello {{customer.name}}</p>'},{mode:'preview'}));
        await page.waitForFunction(()=>window.messages.some(m=>m.__beeflowDocReady));
        await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({__beeflowDocEdit:true,editing:true},'*'));
        const frame=page.frames()[1];
        await frame.waitForSelector('[data-doc-token]');
        assert.equal(await frame.locator('[data-doc-token]').getAttribute('contenteditable'),'false');
        await frame.locator('p').evaluate(el=>el.appendChild(document.createTextNode(' newest edit')));
        await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({__beeflowDocFlush:true,requestId:'export-now'},'*'));
        await page.waitForFunction(()=>window.messages.some(m=>m.requestId==='export-now'));
        const saved=await page.evaluate(()=>window.messages.find(m=>m.requestId==='export-now').html);
        assert.match(saved,/newest edit/);assert.match(saved,/\{\{customer.name\}\}/);assert.doesNotMatch(saved,/data-doc-token/);
        await page.evaluate(html=>{window.messages=[];document.querySelector('iframe').srcdoc=html;},composeDocument(invoice,{mode:'preview'}));
        await page.waitForFunction(()=>window.messages.some(m=>m.__beeflowDocReady));
        await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({__beeflowDocFlush:true,requestId:'table-roundtrip'},'*'));
        await page.waitForFunction(()=>window.messages.some(m=>m.requestId==='table-roundtrip'));
        const roundtrip=await page.evaluate(()=>window.messages.find(m=>m.requestId==='table-roundtrip').html);
        const roundtripFill=prepareDocument({...invoice,bodyHtml:roundtrip},{'customer.name':'Round trip',date:'2026-09-17',summary:'Still a table',lines:[{description:'One',amount:1},{description:'Two',amount:2}],total:3});
        assert.equal(roundtripFill.valid,true);
        assert.match(roundtripFill.bodyHtml,/<td>One<\/td>/);assert.match(roundtripFill.bodyHtml,/<td>Two<\/td>/);
        assert.deepEqual(errors,[]);
    } finally {await browser.close();}
});
