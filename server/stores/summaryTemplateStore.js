// @typecheck
/**
 * Summary Template Store — saved "Regenerate" summary prompts.
 *
 * One table holds three scopes, discriminated by `scope`:
 *   - 'user'  → owned by a single user (user_id)
 *   - 'org'   → visible to a whole organization (organization_id)
 *   - 'group' → visible to one org group (organization_id + group_id)
 *
 * At most one default per scope-owner (a user, an org, or a group), enforced by
 * partial unique indexes. Mirrors the houseStyleStore shape.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');
const { runDdl } = require('./lib/_ddl');
const { pickDefaultTemplate } = require('../utils/summaryTemplates');
const log = require('../telemetry/log');

const SUMMARY_TEMPLATE_COLUMNS = {
    name: 'name',
    prompt: 'prompt',
};

const initDB = makeStoreInit('SummaryTemplateStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS summary_templates (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            user_id TEXT,
            organization_id TEXT,
            group_id TEXT,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            version INTEGER NOT NULL DEFAULT 1,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_summary_templates_user ON summary_templates(user_id);
        CREATE INDEX IF NOT EXISTS idx_summary_templates_org ON summary_templates(organization_id);
        CREATE INDEX IF NOT EXISTS idx_summary_templates_group ON summary_templates(group_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_summary_templates_user_default
            ON summary_templates(user_id) WHERE scope = 'user' AND is_default = TRUE;
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_summary_templates_org_default
            ON summary_templates(organization_id) WHERE scope = 'org' AND is_default = TRUE;
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_summary_templates_group_default
            ON summary_templates(group_id) WHERE scope = 'group' AND is_default = TRUE;
    `);

    // `version` — de revisie van de PROMPT, zodat een notitie kan zeggen met
    // welke versie van dit sjabloon hij geschreven is.
    //
    // Via runDdl (stores/lib/_ddl.js), niet via een migratiebestand en niet in
    // een stille catch: een ALTER die op een lock stukloopt hoort luid te
    // falen, niet als "bestond al" te lezen.
    //
    // Bestaande rijen komen op 1 te staan. Dat is een DEFINITIE (de telling
    // begint hier), geen bewering over het verleden — en hij kan ook niets
    // vals maken: notities van vóór deze wijziging dragen helemaal geen
    // sjabloon-id, dus geen enkele notitie gaat hierdoor "v1" beweren.
    const ddl = await runDdl('summaryTemplateStore', [
        `ALTER TABLE summary_templates ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`,
    ]);
    if (ddl.failures.length > 0) {
        throw new Error(`${ddl.failures.length} migration(s) failed — retry op de volgende aanroep`);
    }
    log.info('[SummaryTemplateStore] PostgreSQL initialized');
}

const COLS = 'id, scope, name, prompt, user_id, organization_id, group_id, is_default, version, created_by, created_at, updated_at';

function mapRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        scope: r.scope,
        name: r.name,
        prompt: r.prompt,
        userId: r.user_id,
        organizationId: r.organization_id,
        groupId: r.group_id,
        isDefault: !!r.is_default,
        // Ontbreekt de kolom (een replica die de ladder nog niet draaide), dan
        // is het antwoord null en niet 1: "ik weet het niet" mag hier niet als
        // "de eerste versie" gelezen worden.
        version: Number.isInteger(Number(r.version)) && Number(r.version) > 0 ? Number(r.version) : null,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

async function getById(id) {
    await initDB();
    const row = await getOne(`SELECT ${COLS} FROM summary_templates WHERE id = $1`, [id]);
    return mapRow(row);
}

/**
 * Templates a user may see in their Regenerate menu: their own user-scope
 * templates, org-scope templates for any org they belong to, and group-scope
 * templates for any group they're in. Empty arrays match nothing (`= ANY('{}')`
 * is false), so passing [] is safe.
 */
async function listVisible({ userId, orgIds = [], groupIds = [] }) {
    await initDB();
    const rows = await getAll(
        `SELECT ${COLS} FROM summary_templates
         WHERE (scope = 'user'  AND user_id = $1)
            OR (scope = 'org'   AND organization_id = ANY($2::text[]))
            OR (scope = 'group' AND group_id = ANY($3::text[]))
         ORDER BY is_default DESC, name ASC, created_at DESC`,
        [userId, orgIds || [], groupIds || []]
    );
    return rows.map(mapRow);
}

/** A user's own personal templates (for the personal settings section). */
async function listForUser(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT ${COLS} FROM summary_templates
         WHERE scope = 'user' AND user_id = $1
         ORDER BY is_default DESC, name ASC, created_at DESC`,
        [userId]
    );
    return rows.map(mapRow);
}

/**
 * All org-wide and group templates for an org (for the org-admin panel — an
 * admin manages every group's templates, not only groups they're a member of).
 */
async function listForOrg(orgId) {
    await initDB();
    const rows = await getAll(
        `SELECT ${COLS} FROM summary_templates
         WHERE organization_id = $1 AND scope IN ('org', 'group')
         ORDER BY scope ASC, is_default DESC, name ASC, created_at DESC`,
        [orgId]
    );
    return rows.map(mapRow);
}

/** Clear the current default for the scope-owner of `row` (before setting a new one). */
async function clearDefault({ scope, userId, organizationId, groupId }) {
    await initDB();
    if (scope === 'user') {
        await run(`UPDATE summary_templates SET is_default = FALSE WHERE scope = 'user' AND user_id = $1 AND is_default = TRUE`, [userId]);
    } else if (scope === 'org') {
        await run(`UPDATE summary_templates SET is_default = FALSE WHERE scope = 'org' AND organization_id = $1 AND is_default = TRUE`, [organizationId]);
    } else if (scope === 'group') {
        await run(`UPDATE summary_templates SET is_default = FALSE WHERE scope = 'group' AND group_id = $1 AND is_default = TRUE`, [groupId]);
    }
}

async function create({ scope, name, prompt, userId = null, organizationId = null, groupId = null, isDefault = false, createdBy = null }) {
    await initDB();
    const id = crypto.randomUUID();
    if (isDefault) await clearDefault({ scope, userId, organizationId, groupId });
    await run(
        `INSERT INTO summary_templates (id, scope, name, prompt, user_id, organization_id, group_id, is_default, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, scope, name, prompt, userId, organizationId, groupId, !!isDefault, createdBy]
    );
    return getById(id);
}

/**
 * Update name / prompt / is_default. Scope and owner are immutable. Setting a
 * template as default first clears the previous default for its scope-owner.
 *
 * ── WANNEER `version` OPHOOGT ────────────────────────────────────────────
 * Alleen als de PROMPT verandert, en alleen als hij echt anders is.
 *
 * De versie is het antwoord op "met welke instructie is die samenvatting
 * geschreven". Hernoemen verandert die instructie niet, en het sjabloon als
 * standaard aanzetten evenmin — een ophoging daar zou notities die met exact
 * dezelfde prompt gemaakt zijn uit elkaar laten lopen op het scherm, en de
 * eerdere versie een verandering laten suggereren die nooit heeft
 * plaatsgevonden. Een opslag-knop die dezelfde tekst terugstuurt (de UI vult
 * het veld voor) is om dezelfde reden geen nieuwe versie.
 */
async function update(id, updates = {}) {
    await initDB();
    const existing = await getById(id);
    if (!existing) return null;

    // Een prompt die gelijk is aan de opgeslagen prompt is geen wijziging, en
    // mag dus ook de versieladder niet optrekken.
    const promptChanged = updates.prompt !== undefined && updates.prompt !== existing.prompt;
    const built = buildUpdate({
        table: 'summary_templates',
        updates: { name: updates.name, prompt: promptChanged ? updates.prompt : undefined },
        columnMap: SUMMARY_TEMPLATE_COLUMNS,
    });
    const values = built ? built.params : [];
    const fields = [];
    if (promptChanged) {
        // COALESCE, want `version` kan op een rij van vóór de ladder nog NULL
        // zijn; `NULL + 1` is NULL en zou de versie stil laten verdwijnen.
        fields.push(`version = COALESCE(version, 1) + 1`);
    }

    if (updates.isDefault === true) {
        await clearDefault(existing);
        fields.push(`is_default = TRUE`);
    } else if (updates.isDefault === false) {
        fields.push(`is_default = FALSE`);
    }

    if (!built && !fields.length) return existing;
    fields.push(`updated_at = NOW()`);
    let i = values.length + 1;
    values.push(id);
    await run(
        `${built ? `${built.sql}, ` : 'UPDATE summary_templates SET '}${fields.join(', ')} WHERE id = $${i++}`,
        values,
    );
    return getById(id);
}

async function remove(id) {
    await initDB();
    const { rowCount } = await run(`DELETE FROM summary_templates WHERE id = $1`, [id]);
    return rowCount > 0;
}

/**
 * Resolve the default template PROMPT for a user (personal ▸ group ▸ org),
 * or null if none is set. Used by the first-generation summary path so a saved
 * default also styles new meetings. Best-effort — callers fall back to the
 * built-in prompt on null/throw.
 */
async function resolveDefaultTemplate({ userId = null, orgIds = [], groupIds = [] }) {
    await initDB();
    const visible = await listVisible({ userId, orgIds, groupIds });
    return pickDefaultTemplate(visible, { userId, orgIds, groupIds });
}

/**
 * The same resolution, reduced to the prompt. Kept because most callers only
 * need the text — but a caller that STAMPS the note (which template, which
 * version) has to take `resolveDefaultTemplate`: an id cannot be recovered
 * from a prompt string, and guessing one back by matching text would name the
 * wrong template the moment two of them share a paragraph.
 */
async function resolveDefaultPrompt({ userId = null, orgIds = [], groupIds = [] }) {
    const def = await resolveDefaultTemplate({ userId, orgIds, groupIds });
    return def ? def.prompt : null;
}

module.exports = {
    initDB,
    getById,
    listVisible,
    listForUser,
    listForOrg,
    create,
    update,
    remove,
    clearDefault,
    resolveDefaultTemplate,
    resolveDefaultPrompt,
};
