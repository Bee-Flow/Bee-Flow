'use strict';

/**
 * What a project holds that the other side of the split refuses
 * (projects/kindChange.js). The container rules are the REAL registry's
 * (projects/membership.js `isAllowedIn` and its kinds); only the counts are
 * fakes, so no store is reached and nothing is mocked through the module
 * system.
 *
 * Proven:
 *   - into a workspace: the Solution-only kinds are counted (apps,
 *     automations, pages, tables, agents); notebooks, documents and meetings
 *     are not, and the chat counts are not even asked for;
 *   - into a Solution: documents and meeting notes, plus filed conversations,
 *     team chats and project files;
 *   - a section with nothing in it is left out, so "nothing held" is `{}`;
 *   - approvals and knowledge bases are never counted (no countIn by design);
 *   - a count that cannot be read fails the check instead of passing it.
 *
 * Run: cd server && node --test projects/kindChange.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const membership = require('./membership');
const { makeKindChange } = require('./kindChange');

const PROJECT = { id: 'p1', filesKbId: 'kb_files' };

/** The real registry, with each kind's countIn answering from `counts` (by section). */
function world({ counts = {}, chats = { conversations: 0, teamChats: 0 }, files = 0, failOn = null } = {}) {
    const asked = [];
    const fakeMembership = {
        isAllowedIn: membership.isAllowedIn,
        countableKinds: () => membership.countableKinds().map((k) => ({
            ...k,
            countIn: async (ids) => {
                asked.push(k.section);
                if (failOn === k.section) throw new Error(`${k.section} store down`);
                return new Map(ids.map((id) => [id, counts[k.section] || 0]));
            },
        })),
    };
    const store = {
        async countChatHoldings(projectId) {
            asked.push('chats');
            assert.strictEqual(projectId, 'p1');
            return chats;
        },
    };
    const projectFiles = {
        async listFiles(project) {
            asked.push('files');
            assert.strictEqual(project, PROJECT);
            return { files: Array.from({ length: files }, (_, i) => ({ id: `f${i}` })), kbId: 'kb_files' };
        },
    };
    return { asked, check: makeKindChange({ membership: fakeMembership, store, projectFiles }) };
}

test('into a workspace: the Solution-only kinds are counted, nothing else', async () => {
    const { asked, check } = world({
        counts: { apps: 2, automations: 1, webpages: 0, datatables: 3, agents: 1, skills: 2, documentTemplates: 6, notebooks: 9, documents: 4, meetings: 5 },
        chats: { conversations: 30, teamChats: 2 },
        files: 7,
    });
    assert.deepStrictEqual(await check.refusedContent(PROJECT, 'workspace'), {
        automations: 1, apps: 2, datatables: 3, agents: 1, skills: 2, documentTemplates: 6,
    });
    assert.deepStrictEqual(asked.sort(), ['agents', 'apps', 'automations', 'datatables', 'documentTemplates', 'skills', 'webpages'],
        'chats, files and the kinds a workspace takes are not even read');
});

test('into a Solution: documents, meeting notes, filed conversations, team chats and files', async () => {
    const { asked, check } = world({
        counts: { apps: 2, automations: 1, notebooks: 9, documents: 4, meetings: 0 },
        chats: { conversations: 30, teamChats: 2 },
        files: 7,
    });
    assert.deepStrictEqual(await check.refusedContent(PROJECT, 'solution'), {
        documents: 4, conversations: 30, teamChats: 2, files: 7,
    });
    assert.ok(!asked.includes('apps') && !asked.includes('notebooks'), 'what a Solution takes is not counted');
});

test('nothing held that the target refuses is an empty answer', async () => {
    const { check } = world({ counts: { notebooks: 3 } });
    assert.deepStrictEqual(await check.refusedContent(PROJECT, 'workspace'), {});
    assert.deepStrictEqual(await check.refusedContent(PROJECT, 'solution'), {});
});

test('approvals and knowledge bases are never counted', async () => {
    const { asked, check } = world();
    await check.refusedContent(PROJECT, 'workspace');
    await check.refusedContent(PROJECT, 'solution');
    assert.ok(!asked.includes('approvals'), 'records that can never be detached would block the change for good');
    assert.ok(!asked.includes('knowledgeBases'), 'both sides take them');
});

test('a count that cannot be read fails the check rather than passing it', async () => {
    const { check } = world({ failOn: 'apps' });
    await assert.rejects(check.refusedContent(PROJECT, 'workspace'), /apps store down/);
});
