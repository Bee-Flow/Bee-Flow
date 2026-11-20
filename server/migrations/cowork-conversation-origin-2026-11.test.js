// @typecheck
/**
 * Marking the conversations Cowork made before conversations had an origin: only a conversation that is
 * demonstrably a Cowork run's, never one a person may have chatted in. On the boot ladder's schema (PGlite).
 *
 * Run: node --test server/migrations/cowork-conversation-origin-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool(ladderPglite());
const { up } = require('./cowork-conversation-origin-2026-11');
test.after(close);

const RUN_AT = '2026-11-01T08:00:00Z';

/**
 * One Cowork item with its conversation. `conv` overrides the conversation, `userMessages` is how many user turns it
 * holds, `runs` how often the item ran (run_count), `project` files it into a project.
 * @param {string} id
 * @param {{ conv?: Record<string, unknown>, userMessages?: number, runs?: number, runAt?: string, messagesMigrated?: boolean }} [o]
 */
async function item(id, { conv = {}, userMessages = 1, runs = 3, runAt = RUN_AT, messagesMigrated = true } = {}) {
    await insertRow(pg, 'agents', { id: `agent-${id}`, name: 'Agent', owner_id: 'u1' });
    await insertRow(pg, 'agent_conversations', {
        id: `conv-${id}`, agent_id: `agent-${id}`, user_id: 'u1', title: 'Run',
        created_at: '2026-11-01T08:00:05Z', updated_at: '2026-11-01T08:01:00Z', messages_migrated: messagesMigrated, ...conv,
    });
    for (let i = 0; i < userMessages; i++) {
        await insertRow(pg, 'conversation_messages', { id: `m-${id}-${i}`, conversation_id: `conv-${id}`, conversation_type: 'agent', role: 'user', content: 'x', seq: i * 2 });
        await insertRow(pg, 'conversation_messages', { id: `a-${id}-${i}`, conversation_id: `conv-${id}`, conversation_type: 'agent', role: 'assistant', content: 'y', seq: i * 2 + 1 });
    }
    await insertRow(pg, 'cowork_schedules', {
        id: `s-${id}`, user_id: 'u1', title: 'Item', prompt: 'p', next_run_at: '2026-12-01T00:00:00Z',
        agent_id: `agent-${id}`, conversation_id: `conv-${id}`, run_count: runs,
    });
    await insertRow(pg, 'cowork_runs', { id: `r-${id}`, schedule_id: `s-${id}`, user_id: 'u1', status: 'success', started_at: runAt, finished_at: '2026-11-01T08:01:00Z' });
}

const origin = async (/** @type {string} */ id) => (await pg.query('SELECT origin FROM agent_conversations WHERE id = $1', [`conv-${id}`])).rows[0]?.origin ?? null;

test('only the conversations a Cowork run demonstrably made are marked', async () => {
    await item('made-by-run');
    // Somebody typed more turns than the item ever ran: a person chatted in it.
    await item('chatted-in', { userMessages: 4, runs: 3 });
    // Written to after the last run of the item.
    await item('written-later', { conv: { updated_at: '2026-11-02T09:00:00Z' } });
    // Created long before any run of the item: an existing chat the item was pointed at.
    await item('older-chat', { conv: { created_at: '2026-10-01T08:00:00Z' } });
    // Filed into a project by a person.
    await insertRow(pg, 'projects', { id: 'p1', name: 'P', owner_id: 'u1' });
    await item('in-project', { conv: { project_id: 'p1' } });
    // The old message blob: its turns cannot be counted, so it is left alone.
    await item('blob', { messagesMigrated: false, userMessages: 0 });

    const res = await up();
    assert.deepEqual(res, { marked: 1, kept: 5 });
    assert.equal(await origin('made-by-run'), 'cowork');
    for (const id of ['chatted-in', 'written-later', 'older-chat', 'in-project', 'blob']) assert.equal(await origin(id), null, id);
});

test('running it again changes nothing', async () => {
    assert.deepEqual(await up(), { marked: 0, kept: 5 });
});
