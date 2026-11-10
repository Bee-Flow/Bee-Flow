'use strict';
// TEST FIXTURE, never shipped (toolRegistry.fixture.test.js): a registry tool that writes the
// app's description, offered over MCP too.
module.exports = {
    name: 'app_zz_note',
    since: 3,
    description: 'Fixture: write one sentence as the app description.',
    schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The sentence.' } },
        required: ['text'],
    },
    apply(draftWrap, args) {
        if (typeof args?.text !== 'string' || !args.text.trim()) return { error: 'Pass `text`: a non-empty sentence.', _fixHint: 'Call again with text.' };
        const ops = require('../../../definitionOps');
        const { adoptCanonical } = require('../../shared');
        const result = adoptCanonical(draftWrap, ops.updateMeta(draftWrap.def, { description: args.text }), {});
        result.meta = { ...draftWrap.def.meta };
        return result;
    },
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'zz_fixture.act_note', en: 'Wrote a note' },
};
