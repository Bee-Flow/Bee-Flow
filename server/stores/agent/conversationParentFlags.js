// @typecheck strict
'use strict';

/**
 * stores/agent/conversationParentFlags.js — the `messages_migrated` flag
 * columns on the parent conversation tables, part of the conversation
 * messages init (./conversationMessages.js, which runs this inside its own
 * schema unit).
 *
 * Added lazily so this is safe on existing databases. Via runDdl
 * (stores/lib/_ddl.js): each statement's failure is reported on its own.
 *
 * The parent tables belong to another store (agent/initSchema.base.js), and
 * boot starts every store's init at once (boot/storeSchemas.js), so on a fresh
 * database these ALTERs can run before those tables exist. runDdl reports that
 * and resolves; the memo would then count the messages init as done and every
 * turn write would fail on the missing column until a restart. A missing
 * parent table therefore fails the init instead: the memo forgets it, and the
 * next caller (the first turn write, placeTurnMessages) runs it again once the
 * tables are there.
 */

const { runDdl, CODES } = require('../lib/_ddl');

async function addParentFlagColumns() {
    const { failures } = await runDdl('conversationMessages', [
        `ALTER TABLE agent_conversations
            ADD COLUMN IF NOT EXISTS messages_migrated BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE direct_conversations
            ADD COLUMN IF NOT EXISTS messages_migrated BOOLEAN DEFAULT FALSE`,
    ]);
    if (failures.some((f) => f.code === CODES.UNDEFINED_TABLE)) {
        throw new Error('conversationMessages: a parent conversation table does not exist yet; the init runs again on the next call');
    }
}

module.exports = { addParentFlagColumns };
