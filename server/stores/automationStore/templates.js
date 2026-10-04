// @typecheck
/**
 * templates.js — organisation templates ("Save as template", Studio →
 * Automations handoff 5). The built-in gallery is static config
 * (automation/templates.js); these rows are what an organisation saved from
 * its own automations, and the gallery lists them first (`source: 'org'`).
 *
 * Scope: a template belongs to the organisation it was saved in and every
 * member sees it. On an install without organisations (organization_id NULL)
 * it is the saver's own. The definition was sanitised on the way in
 * (routes/automation/actions.js uses the export sanitiser), so nothing here
 * filters it again.
 *
 * A factory over a `{ query(sql, params) }` handle so the SQL is tested
 * against a real Postgres without module mocking; the default instance is
 * bound to the pool.
 */

const crypto = require('crypto');

const MAX_LISTED = 200;

function rowToTemplate(r) {
    if (!r) return null;
    let definition = r.definition_json;
    if (typeof definition === 'string') {
        try { definition = JSON.parse(definition); } catch { definition = {}; }
    }
    return {
        id: r.id,
        organizationId: r.organization_id || null,
        createdBy: r.created_by,
        title: r.title,
        description: r.description || '',
        icon: r.icon || null,
        definition: definition || {},
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

/** WHERE clause for "templates this caller may see"; $2 is the org, or the caller without one. */
function scopeSql(orgId) {
    return orgId ? 'organization_id = $2' : '(organization_id IS NULL AND created_by = $2)';
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeTemplateStore(db, { ready = async () => {} } = {}) {
    async function createTemplate({ organizationId = null, createdBy, title, description = null, icon = null, definition }) {
        await ready();
        const id = `org-${crypto.randomUUID()}`;
        const r = await db.query(
            `INSERT INTO automation_templates (id, organization_id, created_by, title, description, icon, definition_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [id, organizationId || null, createdBy, title, description || null, icon || null, JSON.stringify(definition || {})],
        );
        return rowToTemplate(r.rows[0]);
    }

    /** Newest first. */
    async function listTemplatesFor({ userId, orgId = null }) {
        await ready();
        const r = await db.query(
            `SELECT * FROM automation_templates
              WHERE ${scopeSql(orgId)}
              ORDER BY created_at DESC
              LIMIT $1`,
            [MAX_LISTED, orgId || userId],
        );
        return r.rows.map(rowToTemplate);
    }

    /** One template, or null when it does not exist or is not in the caller's scope. */
    async function getTemplateFor(id, { userId, orgId = null }) {
        await ready();
        const r = await db.query(
            `SELECT * FROM automation_templates WHERE id = $1 AND ${scopeSql(orgId)}`,
            [id, orgId || userId],
        );
        return rowToTemplate(r.rows[0] || null);
    }

    return { createTemplate, listTemplatesFor, getTemplateFor };
}

const { initDB, pool } = require('./core');
const defaultStore = makeTemplateStore(
    { query: (sql, params) => pool.query(sql, params) },
    { ready: initDB },
);

module.exports = {
    makeTemplateStore,
    rowToTemplate,
    createAutomationTemplate: defaultStore.createTemplate,
    listAutomationTemplatesFor: defaultStore.listTemplatesFor,
    getAutomationTemplateFor: defaultStore.getTemplateFor,
};
