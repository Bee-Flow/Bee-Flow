/**
 * Migration: automation_agent_bindings (2026-10), which agents may call an
 * `agent_call` automation.
 *
 * Until now an automation with `trigger.kind === 'agent_call'` was offered to
 * every agent, every chat and every unattended surface of its owner. The grant
 * is now an edge between the automation and one agent: one row here, written
 * only through automation/agentBinding.js.
 *
 * It is a TABLE and not a field of the definition on purpose. A definition is
 * copied by duplicate, import, a template, a version restore, packaging and a
 * Solution stage; a grant stored inside it would travel along with every one
 * of those copies, and each of them would then need its own check that the
 * person copying may hand out that grant. Rows here are never copied: a copy
 * of an automation starts with no agent, and the person who wants it callable
 * links the agents again, through the gate. The form URL token
 * (automation_form_pages) and the shares (automation_shares) are stored the
 * same way for the same reason.
 *
 * `agent_id` is a soft reference, not a foreign key: agents live in a store of
 * their own that boots on its own schedule, and the runtime re-checks the agent
 * on every call anyway (a deleted, unpublished or moved agent offers nothing).
 * The agent delete route sweeps its rows. `automation_id` cascades.
 *
 * Idempotent (IF NOT EXISTS): every boot replays the automationStore ladder.
 * `exec` is injectable so a test can run the real SQL against an in-process
 * Postgres.
 */

async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_agent_bindings (
            id              TEXT PRIMARY KEY,
            automation_id   TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            agent_id        TEXT NOT NULL,
            created_by      TEXT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (automation_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_automation_agent_bindings_agent
            ON automation_agent_bindings(agent_id);
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
