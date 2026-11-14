'use strict';
/**
 * The public form routes that take a JSON body of fixed keys refuse any other
 * key by name, before the form is looked up (routes/automation/formPublic/
 * page.js and results.js). The submissions themselves stay open: their keys
 * are the form's own field names, checked against its definition.
 *
 * Run: cd server && node --test routes/automation/formPublic/bodies.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { router } = require('./formPublic.testkit');

/** The refusal the schema in front of `routePath`'s handler gives `body`, or null. */
function refusalOf(routePath, body) {
    const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.post);
    assert.ok(layer, routePath);
    const chain = layer.route.stack;
    let refusal = null;
    chain[chain.length - 2].handle({ body, query: {}, headers: {} }, {}, (err) => { refusal = err || null; });
    return refusal;
}

test('a pick search refuses a key it does not take, by name', () => {
    const err = refusalOf('/form/:token/pick', { field: 'customer', query: 'ac', tool: 'crm_search' });
    assert.strictEqual(err?.status, 400);
    assert.strictEqual(err.code, 'invalid_request');
    assert.match(err.message, /A search from a form does not take "tool"/);
    assert.strictEqual(refusalOf('/form/:token/pick', { field: 'customer', query: 'ac', csrf: 'c', sessionId: 's1' }), null);
});

test('the result actions refuse fields they do not read; the phone\'s notebook text passes the schema', () => {
    assert.match(refusalOf('/form/:token/s/:sid/file/:fileId/notebook', { name: 'x' })?.message, /Opening a file in Notebooks does not take "name"/);
    assert.match(refusalOf('/form/:token/s/:sid/notebook', { text: 'Done', html: '<p>' })?.message, /Saving a result to Notebooks does not take "html"/);
    assert.match(refusalOf('/form/:token/s/:sid/webpage', { slug: 'x' })?.message, /Saving a result as a webpage does not take "slug"/);
    assert.strictEqual(refusalOf('/form/:token/s/:sid/notebook', { text: 'Done', title: 'Result' }), null);
    assert.strictEqual(refusalOf('/form/:token/s/:sid/file/:fileId/notebook', undefined), null);
});
