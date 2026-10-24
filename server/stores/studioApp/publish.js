// @typecheck
/**
 * stores/studioApp/publish.js — who an app reaches and which definition they
 * see: publish / unpublish (freezes the draft and snapshots it), the audience
 * alone for a Solution stage, and a deploy's commit flip.
 */

const { buildUpdate } = require('../lib/sqlBuilder');
const { guardOf, serializeDefinition } = require('./shared');
const { createVersionSnapshot } = require('./versions');
const { rollback } = require('../../txRollback');

/**
 * Toggle published state + sharing scope. When sharedGroups is undefined,
 * preserve the existing DB value (same trap as agents had — see
 * setAgentPublished). organizationId is set on first publish so visibility
 * filters can match against the owner's org without a join.
 *
 * On publish the working definition is frozen: copied into
 * published_definition (viewers keep seeing this while the owner keeps
 * editing), published_at is stamped, published_version records WHICH
 * definition_version went live, and an immutable snapshot row is written to
 * studio_app_versions (pruned to the newest MAX_VERSIONS_PER_APP).
 * Unpublish only flips is_published — the frozen copy, its version and the
 * history stay.
 */
/**
 * @param {object} [publishedDefinition] The already-canonicalized+validated
 *   definition to freeze. Passing it closes a TOCTOU: the route validates a
 *   snapshot read without a lock, so freezing `published_definition = definition`
 *   could otherwise publish a concurrently-saved, unvalidated draft. When
 *   provided, THIS exact def becomes both published_definition and the version
 *   snapshot. Omit to fall back to the (locked) current draft.
 * @param {number} [publishedVersion] The definition_version `publishedDefinition`
 *   was read at. Pass it WITH publishedDefinition: the locked row may already
 *   have moved past that snapshot, and published_version must name the version
 *   whose bytes actually went live, not the one that happened to win the race.
 */
const APP_PUBLISH_COLUMNS = {
    isPublished: 'is_published',
    sharedGroups: { col: 'shared_groups', cast: 'jsonb', transform: v => JSON.stringify(v || []) },
    organizationId: { col: 'organization_id', transform: v => v || null },
    publishedDefinition: { col: 'published_definition', cast: 'jsonb' },
    publishedVersion: 'published_version',
    accentColor: 'accent_color',
};

/** theme.primary out of a definition (object or JSON string); null if absent. */
function readThemePrimary(definition) {
    try {
        const def = typeof definition === 'string' ? JSON.parse(definition) : definition;
        const primary = def && def.theme && def.theme.primary;
        return (typeof primary === 'string' && /^#[0-9a-fA-F]{6}$/.test(primary)) ? primary : null;
    } catch (_) {
        return null;
    }
}

async function setStudioAppPublished(io, id, isPublished, ownerId, sharedGroups = undefined, organizationId = undefined, publishedDefinition = undefined, publishedVersion = undefined) {
    await io.ready();
    return io.db.withTransaction(async (client) => {
        const cur = await client.query(
            `SELECT definition, definition_version, project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [id, ownerId]
        );
        if (cur.rows.length === 0) {
            return rollback(false);
        }
        // ALWAYS refused on an app of a Solution stage, capability or not: a
        // publish here re-freezes the WORKING definition. The audience goes
        // through setStudioAppAudience, the published copy through a deploy's
        // publishDefinitionWith.
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.rows[0].project_id ?? null,
            changedKeys: ['isPublished', 'publishedDefinition'], managedWrite: null, client,
        });

        // The exact bytes that were validated (when supplied) become the frozen
        // published copy — never a racing concurrent draft.
        const frozenPayload = publishedDefinition !== undefined
            ? JSON.stringify(publishedDefinition ?? {})
            : (typeof cur.rows[0].definition === 'string'
                ? cur.rows[0].definition
                : JSON.stringify(cur.rows[0].definition ?? {}));
        const frozenVersion = Number.isInteger(publishedVersion)
            ? publishedVersion
            : (parseInt(cur.rows[0].definition_version) || 1);
        const write = { isPublished: !!isPublished, sharedGroups, organizationId };
        if (isPublished) {
            write.publishedDefinition = frozenPayload;
            write.publishedVersion = frozenVersion;
            // Two accent truths used to drift apart: the app gallery tiles read
            // studio_apps.accent_color while the running app uses
            // definition.theme.primary. Publishing is exactly the moment they
            // must agree — the tile then advertises the app people will see.
            const frozenPrimary = readThemePrimary(frozenPayload);
            if (frozenPrimary) write.accentColor = frozenPrimary;
        }
        // `isPublished` is always mapped, so the stamps below always fire —
        // exactly as when they were literals in the SET clause.
        const built = buildUpdate({
            table: 'studio_apps',
            updates: write,
            columnMap: APP_PUBLISH_COLUMNS,
            extraSet: isPublished ? ['updated_at = NOW()', 'published_at = NOW()'] : ['updated_at = NOW()'],
            where: [{ col: 'id', value: id }, { col: 'user_id', value: ownerId }],
        });
        await client.query(built.sql, built.params);

        if (isPublished) {
            // Same transaction as the freeze (atomic) — pass the client so the
            // snapshot never commits independently of published_definition.
            await createVersionSnapshot(id, ownerId, frozenPayload, 'Published', { client });
        }
        return true;
    });
}

/** The audience columns setStudioAppAudience writes; nothing else. */
const APP_AUDIENCE_COLUMNS = {
    isPublished: APP_PUBLISH_COLUMNS.isPublished,
    sharedGroups: APP_PUBLISH_COLUMNS.sharedGroups,
    organizationId: APP_PUBLISH_COLUMNS.organizationId,
};

/**
 * Who an app reaches: `is_published`, `shared_groups` and `organization_id`
 * only, plus the publish stamps (`published_at` on a publish). It never
 * touches `published_definition` or `published_version`: on an app of a
 * Solution stage those belong to the deploy (publishDefinitionWith), and the
 * audience is the stage's own setting, allowed without a deploy (design 4.3).
 * `sharedGroups` / `organizationId` left undefined keep the stored value.
 * Owner-scoped in the WHERE; false when the app is not the owner's.
 *
 * @param {any} io  the writers' context (makeStudioAppWriters)
 * @param {string} id
 * @param {string} ownerId
 * @param {{ isPublished?: boolean, sharedGroups?: string[], organizationId?: string|null,
 *           managedWrite?: { deploymentId?: string }|null }} [audience]
 */
async function setStudioAppAudience(io, id, ownerId, { isPublished, sharedGroups, organizationId, managedWrite = null } = {}) {
    await io.ready();
    return io.db.withTransaction(async (client) => {
        const cur = await client.query(
            `SELECT project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [id, ownerId]
        );
        if (cur.rows.length === 0) {
            return rollback(false);
        }
        const write = { isPublished: !!isPublished, sharedGroups, organizationId };
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.rows[0].project_id ?? null, managedWrite, client,
            changedKeys: Object.keys(write).filter((k) => write[k] !== undefined),
        });
        const built = buildUpdate({
            table: 'studio_apps',
            updates: write,
            columnMap: APP_AUDIENCE_COLUMNS,
            extraSet: write.isPublished ? ['updated_at = NOW()', 'published_at = NOW()'] : ['updated_at = NOW()'],
            where: [{ col: 'id', value: id }, { col: 'user_id', value: ownerId }],
        });
        await client.query(built.sql, built.params);
        return true;
    });
}

/**
 * A deploy's commit flip for an app: `definition` (the bound release copy,
 * already canonical and validated by the deploy) becomes the frozen
 * `published_definition` at `version`, on the commit transaction's `client`
 * (no BEGIN here; the caller owns the transaction). `is_published` and
 * `shared_groups` are untouched: whether the app is published is the stage's
 * setting, which a deploy never changes. The tile accent follows the
 * published theme, as on a publish.
 *
 * On an app of a Solution stage it needs the deploy's `managedWrite`.
 * Answers true, or false when there is no such app.
 *
 * @param {any} io  the writers' context (makeStudioAppWriters)
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @param {string} id
 * @param {object} definition
 * @param {number} version  the definition_version the release copy was written at
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function publishDefinitionWith(io, client, id, definition, version, { managedWrite = null } = {}) {
    const payload = serializeDefinition(definition);
    const cur = await client.query(`SELECT project_id FROM studio_apps WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.rows.length === 0) return false;
    await guardOf(io).assertManagedWrite({
        kind: 'app', projectId: cur.rows[0].project_id ?? null,
        changedKeys: ['publishedDefinition', 'publishedVersion'], managedWrite, client,
    });
    const write = { publishedDefinition: payload, publishedVersion: Number.isInteger(version) ? version : null };
    const primary = readThemePrimary(payload);
    if (primary) write.accentColor = primary;
    const built = buildUpdate({
        table: 'studio_apps',
        updates: write,
        columnMap: APP_PUBLISH_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    await client.query(built.sql, built.params);
    return true;
}

module.exports = { setStudioAppPublished, setStudioAppAudience, publishDefinitionWith };
