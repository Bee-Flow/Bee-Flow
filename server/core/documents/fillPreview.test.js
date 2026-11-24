'use strict';
/**
 * The picture of a document while it is filled in (fillPreview.mts): the real
 * contract and template code, the composer and the house style handed in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { filledPreview } = require('./fillPreview.mts');

const DOC = {
    id: 'd1', name: 'Offer', kind: 'document', docType: 'quote',
    bodyHtml: '<h1>Offer for {{client}}</h1><p>{{scope}}</p><p>Total {{amount}} on the {{plan}} plan</p><p class="note">{{note}}</p>'
        + '{{#if urgent}}<p class="rush">Rush</p>{{/if}}<ul>{{#each lines}}<li>{{what}}</li>{{/each}}</ul><ol>{{#each extras}}<li>{{what}}</li>{{/each}}</ol>',
    settings: {
        contract: { parameters: [
            { key: 'client', type: 'text', label: 'Client name', required: true },
            { key: 'scope', type: 'text', label: 'Scope of work', required: true },
            { key: 'amount', type: 'number', label: 'Amount', required: true },
            { key: 'plan', type: 'choice', label: 'Plan', options: ['Basic', 'Plus'], default: 'Plus' },
            { key: 'note', type: 'text', label: 'Note' },
            { key: 'urgent', type: 'boolean', label: 'Urgent' },
            { key: 'lines', type: 'list', label: 'Lines', required: true, fields: [{ key: 'what', type: 'text', label: 'What' }] },
            { key: 'extras', type: 'list', label: 'Extras', fields: [{ key: 'what', type: 'text', label: 'What' }] },
        ] },
        sampleValues: { client: 'Van Dijk & Zn <B.V.>', amount: 4800 },
    },
};

function kit() {
    const seen = [];
    const deps = {
        prepare: (doc, values, overrides) => require('./documentContract').prepareDocument(doc, values, overrides),
        setPath: (target, key, value) => require('./documentContract').setPath(target, key, value),
        compose: (doc, options) => { seen.push({ doc, options }); return `<html><!--${options.mode}:${options.houseStyleCss}-->${doc.bodyHtml}</html>`; },
        houseStyleCss: async (_doc, orgId) => `house-of-${orgId}`,
    };
    return { deps, seen };
}

test('what is filled in is shown as it is, and each value still needed as its label in brackets', async () => {
    const { deps, seen } = kit();
    const out = await filledPreview(DOC, 'org1', deps);
    assert.match(out.html, /<h1>Offer for Van Dijk &amp; Zn &lt;B\.V\.&gt;<\/h1>/, 'a value is text, never markup');
    assert.match(out.html, /<p>\[Scope of work\]<\/p>/);
    assert.match(out.html, /Total 4800 on the Plus plan/, 'an empty field prints the default of the template, as the download does');
    assert.match(out.html, /<p class="note"><\/p>/, 'an empty optional field prints nothing, as in the download');
    assert.match(out.html, /<ul><li>\[What\]<\/li><\/ul>/, 'a list that is still needed shows one row of labels');
    assert.match(out.html, /<ol><\/ol>/, 'an optional list stays empty');
    assert.deepEqual(out.gaps, ['scope', 'lines']);
    assert.doesNotMatch(out.html, /Rush/, 'a yes/no nobody answered is not decided by a label');
    assert.doesNotMatch(out.html, /\{\{/);
    assert.deepEqual(seen[0].options, { mode: 'preview', houseStyleCss: 'house-of-org1' });
    assert.equal(DOC.settings.sampleValues.scope, undefined, 'the stored values are not touched');
});

test('with nothing needed left it is the document the download makes', async () => {
    const full = { ...DOC, settings: { ...DOC.settings, sampleValues: { client: 'A', scope: 'B', amount: 1, urgent: true, lines: [{ what: 'One' }] } } };
    const { deps, seen } = kit();
    const out = await filledPreview(full, null, deps);
    assert.deepEqual(out.gaps, []);
    const download = require('./documentContract').prepareDocument(full, full.settings.sampleValues, {});
    assert.equal(download.valid, true);
    assert.equal(seen[0].doc.bodyHtml, download.bodyHtml);
    assert.match(out.html, /class="rush"/);
    assert.match(out.html, /<li>One<\/li>/);
});

test('a presentation is refused: it has its own viewer', async () => {
    await assert.rejects(filledPreview({ ...DOC, docType: 'presentation' }, null, kit().deps), (e) => e.status === 422 && e.errorClass === 'fill_preview_unsupported');
});

test('a filled dotted value stays next to a dotted gap in the same object', async () => {
    const doc = {
        id: 'd2', name: 'Letter', kind: 'document', docType: 'designed',
        bodyHtml: '<p>{{client.name}} {{client.city}}</p>',
        settings: {
            contract: { parameters: [
                { key: 'client.name', type: 'text', label: 'Name', required: true },
                { key: 'client.city', type: 'text', label: 'City', required: true },
            ] },
            sampleValues: { 'client.name': 'Acme' },
        },
    };
    const out = await filledPreview(doc, null, kit().deps);
    assert.match(out.html, /<p>Acme \[City\]<\/p>/);
    assert.deepEqual(out.gaps, ['client.city']);
});
