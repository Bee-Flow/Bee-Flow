/**
 * The house style a document prints with is the organisation's CURRENT one,
 * read at render time, like a presentation's. A document or page made before
 * the letterhead changed carries an older copy in `settings.resolvedHouseStyleCss`;
 * that copy is only a fallback for a render with no organisation to read from.
 *
 * DB-free: the house-style read goes to a map instead of configStore, the PDF
 * renderer through renderFilledDocument's test seam and the composer through
 * the feature registry; the last two only have to show what CSS they were handed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerFeatureModules, _featureModuleGetter } = require('../featureModules');
const houseStyle = require('./documentHouseStyle');
const { houseStyleCssFor, renderFilledDocument, _setDepsForTests } = require('./renderFilledDocument');

/** orgId -> house style, what configStore would hold. */
const styles = new Map();
const composed = [];

const realCompose = _featureModuleGetter('services/documentCompose');
registerFeatureModules({
    'services/documentCompose': () => ({
        composeDocument: (doc, opts) => { composed.push(opts.houseStyleCss); return `<html>${doc.bodyHtml}</html>`; },
    }),
});
_setDepsForTests({
    getHouseStyle: async (orgId) => styles.get(orgId) ?? houseStyle.normaliseStyle({}),
    renderStyledHtmlToPdf: async () => ({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf', degraded: false, marking: null }),
});

test.after(() => {
    _setDepsForTests(null);
    if (realCompose) registerFeatureModules({ 'services/documentCompose': realCompose });
});

const OLD = '#112233';
const NEW = '#445566';

async function styleIs(orgId, accent, enabled = true) {
    styles.set(orgId, houseStyle.normaliseStyle({ enabled, accent }));
}

/** A document as it was stored before the house style changed. */
function storedWithOldStyle(docType, extra = {}) {
    return {
        id: `doc-${docType}`, name: 'Letter', docType, organizationId: 'org-a',
        bodyHtml: '<p>Hello</p>', css: '',
        settings: { resolvedHouseStyleCss: houseStyle.houseStyleCss(houseStyle.normaliseStyle({ enabled: true, accent: OLD })), ...extra },
    };
}

test('a designed document made before a house-style change renders with the new style', async () => {
    await styleIs('org-a', NEW);
    const css = await houseStyleCssFor(storedWithOldStyle('letter'), 'org-a');
    assert.match(css, new RegExp(NEW));
    assert.doesNotMatch(css, new RegExp(OLD));
});

test('a page made before a house-style change renders with the new style', async () => {
    await styleIs('org-a', NEW);
    const css = await houseStyleCssFor(storedWithOldStyle('page'), 'org-a');
    assert.match(css, new RegExp(NEW));
});

test('a document with the house style turned off renders without one', async () => {
    await styleIs('org-a', NEW);
    assert.equal(await houseStyleCssFor(storedWithOldStyle('letter', { houseStyle: false }), 'org-a'), '');
});

test('an organisation that switched its house style off: documents follow, the old copy is not used', async () => {
    await styleIs('org-a', NEW, false);
    assert.equal(await houseStyleCssFor(storedWithOldStyle('letter'), 'org-a'), '');
});

test('a presentation still wears no CSS layer (its deck theme is read at render time)', async () => {
    await styleIs('org-a', NEW);
    assert.equal(await houseStyleCssFor(storedWithOldStyle('presentation'), 'org-a'), '');
});

test('a render without a caller organisation reads the document\'s own organisation', async () => {
    await styleIs('org-a', NEW);
    assert.match(await houseStyleCssFor(storedWithOldStyle('letter'), null), new RegExp(NEW));
});

test('with no organisation at all, the stored copy is the fallback', async () => {
    const doc = { ...storedWithOldStyle('letter'), organizationId: null };
    assert.match(await houseStyleCssFor(doc, null), new RegExp(OLD));
    assert.equal(await houseStyleCssFor({ ...doc, settings: {} }, null), '');
});

test('the automation / app render path prints a pinned version with the current style', async () => {
    await styleIs('org-a', NEW);
    composed.length = 0;
    const out = await renderFilledDocument({ document: storedWithOldStyle('letter'), values: {}, orgId: 'org-a' });
    assert.equal(out.extension, 'pdf');
    assert.equal(composed.length, 1);
    assert.match(composed[0], new RegExp(NEW));
    assert.doesNotMatch(composed[0], new RegExp(OLD));
});
