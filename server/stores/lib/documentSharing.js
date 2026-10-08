'use strict';

const { getAll, run, withTransaction } = require('../../db');
const { HttpError } = require('../../shared/httpErrors');

// Null keeps the existing team-template audience until its owner changes it.
function sharingDdl(table) {
    return `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sharing_audience TEXT;
        ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS shared_groups JSONB NOT NULL DEFAULT '[]';
        ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS shared_user_ids JSONB NOT NULL DEFAULT '[]';`;
}

function sharingSql(alias, user = '$2') {
    return `EXISTS (SELECT 1 FROM users reader WHERE reader.id = ${user}
        AND NULLIF(${alias}.organization_id, '') = reader."organizationId"
        AND (${alias}.sharing_audience = 'organisation' OR
            (${alias}.sharing_audience = 'restricted' AND
                (${alias}.shared_user_ids ? reader.id OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(${alias}.shared_groups) shared_group(id)
                    WHERE COALESCE(NULLIF(to_jsonb(reader)->>'groups', ''), '[]')::jsonb ? shared_group.id)))))`;
}

function visibilitySql(alias) {
    return `CASE WHEN ${alias}.sharing_audience IN ('organisation','restricted') THEN 'team'
        WHEN ${alias}.sharing_audience = 'private' THEN 'private' ELSE ${alias}.visibility END`;
}

function sharingOf(row) {
    return {
        audience: row.sharing_audience || (row.visibility === 'team' ? 'organisation' : 'private'),
        sharedGroups: row.shared_groups || [], sharedUserIds: row.shared_user_ids || [],
    };
}

function tableFor(type) {
    if (type === 'document') return 'studio_documents';
    if (type === 'notebook') return 'notebooks';
    throw new HttpError(400, 'document_type_invalid', 'Unknown document type.');
}

async function owned(client, type, id, userId) {
    const table = tableFor(type);
    const { rows } = await client.query(`SELECT d.* FROM ${table} d JOIN users u ON u.id = d.user_id
        WHERE d.id = $1 AND d.user_id = $2
        AND (d.organization_id IS NULL OR d.organization_id = u."organizationId")
        ${type === 'document' ? 'AND d.archived = false' : "AND d.type = 'notebook'"} FOR UPDATE OF d`, [id, userId]);
    if (!rows[0]) throw new HttpError(404, 'document_not_found', 'Document not found.');
    return rows[0];
}

async function ready(type) {
    await require(type === 'notebook' ? '../notebookStore' : '../documentStore').initDB();
}

async function getSharing(type, id, userId) {
    await ready(type);
    return withTransaction(async (client) => {
        const row = await owned(client, type, id, userId);
        return { ...sharingOf(row), organizationId: row.organization_id || null };
    });
}

async function setSharing(type, id, userId, input) {
    await ready(type);
    const files = { created: [], replaced: [] };
    const execute = (reencrypt) => withTransaction(async (client) => {
        const row = await owned(client, type, id, userId);
        const { audience } = input;
        if (!['private', 'organisation', 'restricted'].includes(audience)) {
            throw new HttpError(400, 'bad_audience', 'Choose private, organisation, or specific people and groups.');
        }
        const groups = audience === 'restricted' ? [...new Set(input.sharedGroups || [])] : [];
        const users = audience === 'restricted' ? [...new Set(input.sharedUserIds || [])] : [];
        if (audience !== 'private' && !row.organization_id) {
            throw new HttpError(400, 'no_organisation', 'This document has no organisation to share with.');
        }
        if (audience === 'restricted' && !groups.length && !users.length) {
            throw new HttpError(400, 'recipients_required', 'Choose at least one person or group.');
        }
        for (const [table, ids] of [['users', users], ['groups', groups]]) {
            if (!ids.length) continue;
            const { rows } = await client.query(`SELECT id FROM ${table} WHERE id = ANY($1::text[]) AND "organizationId" = $2`, [ids, row.organization_id]);
            if (rows.length !== ids.length) throw new HttpError(400, 'recipient_unknown', 'A recipient does not belong to this organisation.');
        }
        if (reencrypt) await require('./documentSharingCrypto').transition(client, type, row, audience, files);
        await client.query(`UPDATE ${tableFor(type)} SET sharing_audience = $2, shared_groups = $3::jsonb,
            shared_user_ids = $4::jsonb${type === 'document' ? ", visibility = 'private'" : ''} WHERE id = $1`,
        [id, audience, JSON.stringify(groups), JSON.stringify(users)]);
        return { audience, sharedGroups: groups, sharedUserIds: users, organizationId: row.organization_id || null };
    });
    let result;
    try {
        result = await execute(true);
    } catch (e) {
        await require('./notebookFileCrypto').removeFiles(files.created);
        if (input.audience !== 'private' || e.status !== 423) throw e;
        // Revoking access must work while encryption is locked. Existing
        // envelopes retain their key context and remain readable when unlocked.
        files.created.length = 0; files.replaced.length = 0;
        result = await execute(false);
    }
    await require('./notebookFileCrypto').removeFiles(files.replaced);
    return result;
}

// Directory is scoped to the owned document's organisation, not session input.
async function sharingDirectory(type, id, userId) {
    const { organizationId } = await getSharing(type, id, userId);
    if (!organizationId) return { users: [], groups: [] };
    const [users, groups] = await Promise.all([
        getAll(`SELECT id, COALESCE(NULLIF("displayName", ''), username) AS name FROM users
            WHERE "organizationId" = $1 ORDER BY name`, [organizationId]),
        getAll('SELECT id, name FROM groups WHERE "organizationId" = $1 ORDER BY name', [organizationId]),
    ]);
    return { users: users.filter((u) => u.id !== userId), groups };
}

async function revokeGroupShares(groupId) {
    // Stores are initialized independently; only touch installed sharing columns.
    const tables = await getAll(`SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('studio_documents', 'notebooks')
        AND column_name = 'shared_groups'`);
    for (const { table_name: table } of tables) {
        await run(`UPDATE ${table} SET shared_groups = shared_groups - $1::text WHERE shared_groups ? $1`, [groupId]);
    }
}

module.exports = { sharingDdl, sharingSql, visibilitySql, sharingOf, getSharing, setSharing, sharingDirectory, revokeGroupShares };
