import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { canonicalOnDecided, canonicalQuestions, canonicalStages, withoutSupersededApprovers } from './stepFieldShapes';

const require = createRequire(import.meta.url);
const { cleanApprovalQuestions, cleanApprovalStages, cleanApprovalOnDecided } = require('../../../../../../../../server/appStudio/canonicalize/approvals.js');
const quiet = () => {};

/** The editor's shapes against the server's own cleaners: the same input gives the same stored value. */
describe('stepFieldShapes agree with canonicalize/approvals.js', () => {
    it('questions: empty label, required false and options on a non-choice are not stored', () => {
        const input = [
            { name: 'q1', type: 'text', label: '', required: false },
            { name: 'ok', type: 'checkbox', label: 'Received?', required: true, help: 'Tick it' },
            { name: 'pick', type: 'select', label: 'Which', options: [{ value: 'a', label: 'a' }, 'b'] },
            { name: 'stray', type: 'number', options: ['x'] },
            { name: 'odd', type: 'file' },
        ];
        expect(canonicalQuestions(input)).toEqual(cleanApprovalQuestions(input, 'p', quiet));
    });

    it('stages: unpicked and repeated seats go, an empty stage goes, quorum is clamped, a binding name stays', () => {
        const input = [
            { key: 'lead', approvers: [{ groupId: 'g1' }, {}, { groupId: 'g1' }, { userId: 'u1' }], rule: 'quorum', quorum: 9, name: 'Lead', when: 'vars.x > 1' },
            { key: 'empty', approvers: [], rule: 'all' },
            { key: 'fin', approvers: [{ userId: 'u2' }], rule: 'nope', name: { kind: 'formula', expr: 'vars.n' }, description: '' },
        ];
        expect(canonicalStages(input)).toEqual(cleanApprovalStages(input, 'p', quiet));
    });

    it('onDecided: empty outcome maps, blank columns and non-scalar values are not stored', () => {
        const input = { tableId: 't1', recordId: { kind: 'formula', expr: 'vars.id' }, set: { approved: { status: 'ok', note: null, n: 3, bad: { x: 1 }, '': 'x' }, rejected: {} } };
        expect(canonicalOnDecided(input)).toEqual(cleanApprovalOnDecided(input, 'p', quiet));
        expect(canonicalOnDecided({ set: { approved: {} } })).toBe(cleanApprovalOnDecided({ set: { approved: {} } }, 'p', quiet));
    });

    it('a chain clears the approvers it supersedes, the way canonicalize writes them unset', () => {
        const step = { kind: 'request_approval', assigneeUserId: 'u1', approverUserIds: ['u2'], escalateToGroupId: 'g', rule: 'all' };
        expect(withoutSupersededApprovers(step)).toEqual({ kind: 'request_approval', assigneeUserId: null, escalateToGroupId: null, rule: 'all' });
    });
});
