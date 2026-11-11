// @typecheck strict
'use strict';
// TEST FIXTURE, never shipped (toolRegistry.fixture.test.js): a read-only registry tool for the
// in-product builder only.
module.exports = {
    name: 'app_zz_peek',
    since: 3,
    description: 'Fixture: answer how many screens the draft has. NO arguments.',
    schema: { type: 'object', properties: {} },
    apply: (/** @type {{ def?: { screens?: unknown[] } }} */ draftWrap) => ({ screens: Array.isArray(draftWrap?.def?.screens) ? draftWrap.def.screens.length : 0 }),
    mutating: false,
    core: false,
    mcp: false,
    verb: { key: 'zz_fixture.act_peek', en: 'Counted the screens' },
};
