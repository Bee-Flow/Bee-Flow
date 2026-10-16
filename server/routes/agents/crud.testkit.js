/**
 * Shared setup for the routes/agents/crud*.test.js files: stub the requires
 * that crud.js and its split siblings (crudSchemas, agentPersonaWrite,
 * agentUpdate) make, so the router loads without the LLM/DB graph.
 *
 * Every test file kept its own copy of this resolve hook, and each split of
 * crud.js meant editing all of them; the module list now lives here once.
 */

'use strict';

const Module = require('module');

/** The modules whose requires the crud tests stub. */
const CRUD_MODULES = /agents[\\/](crud|crudSchemas|agentPersonaWrite|agentUpdate)\.js$/;

/**
 * Register `mocks` (request string → exports) in require.cache under
 * `mock:<tag>:<request>` and route those requests from the crud modules to
 * them. Returns a function that restores the original resolver.
 */
function stubCrudRequires(mocks, tag) {
    const mockIds = {};
    for (const [request, exportsObj] of Object.entries(mocks)) {
        const mockId = `mock:${tag}:${request}`;
        mockIds[request] = mockId;
        require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
    }
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...rest) {
        if (parent && CRUD_MODULES.test(parent.filename) && Object.prototype.hasOwnProperty.call(mockIds, request)) {
            return mockIds[request];
        }
        return originalResolve.call(this, request, parent, ...rest);
    };
    return () => { Module._resolveFilename = originalResolve; };
}

module.exports = { CRUD_MODULES, stubCrudRequires };
