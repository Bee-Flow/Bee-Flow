'use strict';
// The four route call sites that used a bare fetch() on a configured URL now go
// through the SSRF layer; this pins the refusal the layer gives them.
const test = require('node:test');
const assert = require('node:assert');
const { safeFetch } = require('../../utils/ssrfGuard');
const { fetchConfiguredEndpoint } = require('./configuredEndpointFetch');

test('reranker (strict guard) refuses private and metadata targets', async () => {
    await assert.rejects(safeFetch('http://169.254.169.254/v1/rerank'), /Refused/);
    await assert.rejects(safeFetch('http://127.0.0.1:1/v1/rerank'), /Refused/);
});

test('provider listing / gateway (admin guard) refuses the metadata service', async () => {
    await assert.rejects(fetchConfiguredEndpoint('http://169.254.169.254/v1/models'), /Refused/);
});
