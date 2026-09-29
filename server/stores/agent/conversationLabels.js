// @typecheck
/**
 * Conversation Labels - User-defined labels for organizing conversations
 */

const { v4: uuidv4 } = require('uuid');
const { run, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { buildUpdate } = require('../lib/sqlBuilder');

async function listLabels(userId) {
    await initDB();
    return getAll('SELECT id, name, color, created_at FROM conversation_labels WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
}

async function createLabel(userId, name, color) {
    await initDB();
    const id = uuidv4();
    await run('INSERT INTO conversation_labels (id, user_id, name, color) VALUES ($1, $2, $3, $4)', [id, userId, name, color]);
    return { id, name, color };
}

const LABEL_COLUMNS = { name: 'name', color: 'color' };

async function updateLabel(id, userId, updates) {
    await initDB();
    const built = buildUpdate({
        table: 'conversation_labels',
        updates,
        columnMap: LABEL_COLUMNS,
        where: [{ col: 'id', value: id }, { col: 'user_id', value: userId }],
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

async function deleteLabel(id, userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM conversation_labels WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
}

module.exports = { listLabels, createLabel, updateLabel, deleteLabel };
