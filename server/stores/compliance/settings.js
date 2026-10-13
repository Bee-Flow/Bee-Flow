// @typecheck
/**
 * The settings row: read (with jsonb shape repair), the table-driven
 * merge-on-write, and the columns with their own writers (onboarding stamp,
 * SCC attestations, RoPA review, retention heartbeat).
 *
 * The db helpers and the store's initDB come in from the barrel
 * (stores/complianceStore.js), so this module requires no database itself.
 */

const { SETTINGS_FIELDS, SETTINGS_READONLY } = require('./settingsFields');

const _cloneFallback = (f) => (f.fallback !== undefined ? JSON.parse(JSON.stringify(f.fallback)) : null);

function _emptySettings(orgId) {
    const out = { organization_id: orgId || 'default' };
    for (const f of [...SETTINGS_FIELDS, ...SETTINGS_READONLY]) out[f.col] = _cloneFallback(f);
    return out;
}

/**
 * Normalise a row from the driver: jsonb columns come back parsed by pg, but
 * a text-typed mock, a legacy CSV import or a NULL cell must still yield the
 * declared shape (array/object), never `null` or a string the UI has to guard.
 */
function _parseSettingsRow(row) {
    const out = { ...row };
    for (const f of [...SETTINGS_FIELDS, ...SETTINGS_READONLY]) {
        if (f.kind !== 'jsonb') continue;
        let v = out[f.col];
        if (typeof v === 'string') {
            try { v = JSON.parse(v); } catch { v = undefined; }
        }
        const wantArray = Array.isArray(f.fallback);
        const ok = v != null && (wantArray ? Array.isArray(v) : (typeof v === 'object' && !Array.isArray(v)));
        out[f.col] = ok ? v : _cloneFallback(f);
    }
    return out;
}

/** Resolve one field's value from the patch + the stored row per the rules above. */
function _mergeField(f, patch, existing) {
    const fallback = _cloneFallback(f);
    let v;
    if (f.legacy) {
        v = patch[f.col] ?? existing?.[f.col] ?? fallback;
    } else if (Object.prototype.hasOwnProperty.call(patch, f.col) && patch[f.col] !== undefined) {
        v = patch[f.col] === null ? fallback : patch[f.col];
    } else {
        v = existing?.[f.col] ?? fallback;
    }
    return f.kind === 'jsonb' ? JSON.stringify(v) : v;
}

const _bindCast = (f) => (f.kind === 'jsonb' ? '::jsonb' : '');

/**
 * @param {{ run: Function, getOne: Function, initDB: () => Promise<any> }} deps
 */
function createSettings({ run, getOne, initDB }) {
    async function getSettings(orgId) {
        await initDB();
        const row = await getOne(`SELECT * FROM compliance_settings WHERE organization_id = $1`, [orgId || 'default']);
        if (!row) return _emptySettings(orgId);
        return _parseSettingsRow(row);
    }

    /**
     * Whitelisted, merge-on-write update of the settings row. Unknown keys in
     * `patch` are dropped; SETTINGS_FIELDS is the only source of the column list,
     * so adding a field is one entry there (DDL + write + read follow).
     */
    async function saveSettings(orgId, patch) {
        await initDB();
        const p = patch || {};
        const existing = await getOne(`SELECT * FROM compliance_settings WHERE organization_id = $1`, [orgId]);
        const values = SETTINGS_FIELDS.map(f => _mergeField(f, p, existing));
        if (existing) {
            const assignments = SETTINGS_FIELDS.map((f, i) => `${f.col} = $${i + 2}${_bindCast(f)}`);
            await run(`
                UPDATE compliance_settings SET
                    ${assignments.join(',\n                ')},
                    updated_at = NOW()
                WHERE organization_id = $1
            `, [orgId, ...values]);
        } else {
            const cols = SETTINGS_FIELDS.map(f => f.col);
            const binds = SETTINGS_FIELDS.map((f, i) => `$${i + 2}${_bindCast(f)}`);
            await run(`
                INSERT INTO compliance_settings
                    (organization_id, ${cols.join(', ')})
                VALUES ($1, ${binds.join(', ')})
            `, [orgId, ...values]);
        }
        return getSettings(orgId);
    }

    async function markOnboarded(orgId) {
        await initDB();
        await run(`
            UPDATE compliance_settings SET onboarded_at = NOW(), updated_at = NOW()
            WHERE organization_id = $1 AND onboarded_at IS NULL
        `, [orgId]);
    }

    // ───────────────────────── SCC attestation ─────────────────────────
    //
    // Admins confirm that Standard Contractual Clauses are in place for a given
    // processor (operator name as it appears in integration_activity_log.operator).
    // Each entry stores who attested and when so it is auditable via the evidence
    // chain. Removing an operator does NOT delete prior evidence rows.

    async function setSccConfirmed(orgId, operator, confirmed, attestedBy) {
        await initDB();
        const existing = await getSettings(orgId);
        const list = Array.isArray(existing.scc_confirmed_operators) ? existing.scc_confirmed_operators : [];
        const filtered = list.filter(e => (e?.operator || '').toLowerCase() !== String(operator).toLowerCase());
        const next = confirmed
            // Keep the DORA register-of-information fields (contract_ref, critical,
            // country) a previous attestation may carry — re-confirming SCC must
            // not silently drop them (CHECK-CATALOGUE §2.6).
            ? [...filtered, {
                ...(list.find(e => (e?.operator || '').toLowerCase() === String(operator).toLowerCase()) || {}),
                operator, attested_by: attestedBy || null, attested_at: new Date().toISOString(),
            }]
            : filtered;
        await run(`
            INSERT INTO compliance_settings (organization_id, scc_confirmed_operators, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (organization_id)
            DO UPDATE SET scc_confirmed_operators = EXCLUDED.scc_confirmed_operators, updated_at = NOW()
        `, [orgId, JSON.stringify(next)]);
        return next;
    }

    // ───────────────────────── RoPA review ─────────────────────────

    async function markRopaReviewed(orgId, reviewerId) {
        await initDB();
        await run(`
            INSERT INTO compliance_settings (organization_id, ropa_reviewed_at, ropa_reviewed_by, updated_at)
            VALUES ($1, NOW(), $2, NOW())
            ON CONFLICT (organization_id)
            DO UPDATE SET ropa_reviewed_at = NOW(), ropa_reviewed_by = $2, updated_at = NOW()
        `, [orgId, reviewerId || null]);
    }

    // ───────────────────────── Retention enforcer heartbeat ─────────────────────────

    async function markRetentionRun(orgId) {
        await initDB();
        await run(`
            INSERT INTO compliance_settings (organization_id, last_retention_run_at, updated_at)
            VALUES ($1, NOW(), NOW())
            ON CONFLICT (organization_id)
            DO UPDATE SET last_retention_run_at = NOW(), updated_at = NOW()
        `, [orgId]);
    }

    return {
        getSettings,
        saveSettings,
        markOnboarded,
        setSccConfirmed,
        markRopaReviewed,
        markRetentionRun,
    };
}

module.exports = { createSettings };
