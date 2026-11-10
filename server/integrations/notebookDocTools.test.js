const test = require('node:test');
const assert = require('node:assert/strict');
const { executeNotebookDocTool } = require('./notebookDocTools');

const MD = '# Notes\n\nThe formula goes here.\n\nTotal:   TBD\nend';

test('notebook_doc_replace: the replacement is literal text, not a String.replace pattern', () => {
    const replaceText = '$$E = mc^2$$ costs $& and $1';
    const out = executeNotebookDocTool('notebook_doc_replace', { find_text: 'The formula goes here.', replace_text: replaceText }, '', MD);
    assert.equal(out.error, undefined);
    assert.ok(out.contentMd.includes(`${replaceText}\n\nTotal:`), out.contentMd);
});

test('notebook_doc_replace: the whitespace-tolerant path is literal too', () => {
    const out = executeNotebookDocTool('notebook_doc_replace', { find_text: 'Total: TBD', replace_text: 'Total: $$40' }, '', MD);
    assert.equal(out.error, undefined);
    assert.ok(out.contentMd.includes('Total: $$40\nend'), out.contentMd);
});
