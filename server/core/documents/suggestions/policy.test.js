'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shouldSuggest } = require('./policy');

const page = (extra = {}) => ({ docType: 'page', projectId: null, visibility: 'private', sharing: { audience: 'private' }, ...extra });

test('direct write only for a page made in this chat, private, unfiled and not live', () => {
    assert.strictEqual(shouldSuggest({ doc: page(), createdInThisChat: true, liveSession: false }), false);
});

test('every other combination is suggested', () => {
    const rows = [
        ['merely opened', { doc: page(), createdInThisChat: false, liveSession: false }],
        ['filed in a project', { doc: page({ projectId: 'p1' }), createdInThisChat: true, liveSession: false }],
        ['shared with the organisation', { doc: page({ sharing: { audience: 'organisation' } }), createdInThisChat: true, liveSession: false }],
        ['shared with named people', { doc: page({ sharing: { audience: 'restricted' } }), createdInThisChat: true, liveSession: false }],
        ['a team library item', { doc: page({ sharing: undefined, visibility: 'team' }), createdInThisChat: true, liveSession: false }],
        ['a live session is open', { doc: page(), createdInThisChat: true, liveSession: true }],
        ['nothing known', { doc: page(), createdInThisChat: undefined, liveSession: undefined }],
    ];
    for (const [why, input] of rows) assert.strictEqual(shouldSuggest(input), true, why);
});

test('a missing sharing object reads as private; other doc types keep today\'s behaviour', () => {
    assert.strictEqual(shouldSuggest({ doc: page({ sharing: undefined }), createdInThisChat: true }), false);
    assert.strictEqual(shouldSuggest({ doc: { docType: 'presentation', projectId: 'p1' }, createdInThisChat: false }), false);
    assert.strictEqual(shouldSuggest({ doc: null }), false);
});
