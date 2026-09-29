/**
 * Migration: address a datatable by a SCOPE, not by an organisation (2026-09).
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────
 * `datatables.organization_id` was NOT NULL and `datatable_models.organization_id`
 * was the PRIMARY KEY, so an account with no organisation could not own a table
 * — POST /api/datatables answered 400 `no_organisation`. That account is not an
 * edge case: the built-in `admin` operator's organizationId is the EMPTY STRING
 * (stores/user/users.createUser writes `organizationId || ''`), POST /setup's
 * instance operator gets none at all, and accountProvisioning.consumerPlacement
 * documents "no organisation" as a supported placement. BFSF-412 was filed from
 * exactly such an account.
 *
 * ── WHY A SCOPE KEY AND NOT A NULLABLE COLUMN ───────────────────────
 * `datatable_models` holds ONE model document per tenant, and that tenant also
 * names one physical Postgres schema and one migration ladder. A NULL cannot
 * address a tenant — every org-less account in the deployment would share the
 * single NULL row and therefore one schema. So the key becomes the pair
 * `(scope_kind, scope_id)`: `('org', <orgId>)` or `('user', <userId>)`.
 *
 * `organization_id` STAYS, redefined as "the org this table belongs to; NULL for
 * a personal table". Org teardown, the org indexes, admin queries and the new
 * FK to `organizations` all need a truthful column to filter on.
 *
 * ── WHY IT IS SAFE TO RE-RUN ────────────────────────────────────────
 * Every step is guarded on its own outcome rather than on a marker row:
 * ADD COLUMN IF NOT EXISTS, a backfill with `WHERE scope_id IS NULL`, a PK swap
 * that first asks pg_index whether the primary key already covers
 * (scope_kind, scope_id), and an FK added only when one of that name is absent.
 * A second run finds every question already answered and does nothing.
 *
 * Ordered so a crash between any two steps leaves a readable database: the
 * columns and the backfill land before anything is dropped, and the old unique
 * index is only replaced once the new one exists.
 */

const { getOne, run } = require('../db');

/** A text[] as node-postgres or pglite hands it back, as a JS array. */
function toArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
    return [];
}

/** Does the primary key of `table` already cover exactly `cols`? */
async function pkCovers(table, cols) {
    const r = await getOne(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [table],
    );
    const have = toArray(r?.cols).slice().sort();
    const want = cols.slice().sort();
    return have.length === want.length && have.every((c, i) => c === want[i]);
}

async function up() {
    // A fresh install reaches this migration with no datatable tables at all —
    // datatableStore.createSchema already creates them in the scoped shape.
    const probe = await getOne(`SELECT to_regclass('datatable_models') AS t`).catch(() => null);
    if (!probe?.t) return;

    // 1. The columns. `scope_id` starts nullable so the backfill has somewhere
    //    to write; the NOT NULL goes on in step 4, once every row has one.
    for (const t of ['datatables', 'datatable_models', 'datatable_grants', 'automation_datatable_usage']) {
        await run(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS scope_kind TEXT NOT NULL DEFAULT 'org'`);
        await run(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS scope_id TEXT`);
    }

    // 2. `organization_id` stops being the tenant key, so it stops being
    //    mandatory. It has to happen BEFORE the normalisation below: a personal
    //    table has no organisation, and `SET organization_id = NULL` under a
    //    NOT NULL is a failed migration rather than a repair.
    await run(`ALTER TABLE datatables ALTER COLUMN organization_id DROP NOT NULL`);
    await run(`ALTER TABLE automation_datatable_usage ALTER COLUMN organization_id DROP NOT NULL`);

    // 3. An org-less account holds the EMPTY STRING, not NULL, and '' is not a
    //    tenant key: it would collapse every such account into one schema. No
    //    row can hold it today (createDatatable refuses a falsy organizationId
    //    and the column was NOT NULL), so this only ever normalises a row a
    //    future bug writes — before the backfill turns it into a scope.
    await run(`UPDATE datatables SET organization_id = NULL WHERE organization_id = ''`);

    // 4. Backfill. Guarded on `scope_id IS NULL`, so a re-run is a no-op and a
    //    row written by the new code (which sets both) is never rewritten.
    await run(`UPDATE datatables SET scope_kind = 'org', scope_id = organization_id
                WHERE scope_id IS NULL AND organization_id IS NOT NULL`);
    // The repair branch for a row whose organisation was '' — it is a personal
    // table, and its owner is the only account that could ever have reached it.
    await run(`UPDATE datatables SET scope_kind = 'user', scope_id = owner_user_id
                WHERE scope_id IS NULL AND organization_id IS NULL`);
    await run(`UPDATE datatable_models SET scope_kind = 'org', scope_id = organization_id
                WHERE scope_id IS NULL`);
    // Grants and usage rows have no organisation of their own — they inherit
    // the scope of the table they hang off, which the FK guarantees exists.
    await run(`UPDATE datatable_grants g SET scope_kind = d.scope_kind, scope_id = d.scope_id
                 FROM datatables d WHERE d.id = g.datatable_id AND g.scope_id IS NULL`);
    await run(`UPDATE automation_datatable_usage u SET scope_kind = d.scope_kind, scope_id = d.scope_id
                 FROM datatables d WHERE d.id = u.datatable_id AND u.scope_id IS NULL`);

    // 5. Only the two tables every query narrows on get NOT NULL. A grant and a
    //    usage row are reached through `datatable_id`, which is already scoped,
    //    so their copy is an audit convenience — and a NOT NULL there would
    //    turn one unreachable orphan into a migration that fails for everybody.
    await run(`ALTER TABLE datatables ALTER COLUMN scope_id SET NOT NULL`);
    await run(`ALTER TABLE datatable_models ALTER COLUMN scope_id SET NOT NULL`);

    // 6. The primary key moves to the scope. Asked of pg_index rather than of
    //    pg_constraint by name, because a fresh install already declares
    //    PRIMARY KEY (scope_kind, scope_id) — and Postgres names that
    //    `datatable_models_pkey` too, so a name check would "find" it and then
    //    drop the right key.
    if (!(await pkCovers('datatable_models', ['scope_kind', 'scope_id']))) {
        await run(`ALTER TABLE datatable_models DROP CONSTRAINT IF EXISTS datatable_models_pkey`);
        await run(`ALTER TABLE datatable_models ADD PRIMARY KEY (scope_kind, scope_id)`);
    }
    // Dropping the PK does not drop the NOT NULL it implied, and a personal
    // model has no organisation.
    await run(`ALTER TABLE datatable_models ALTER COLUMN organization_id DROP NOT NULL`);

    // 7. Uniqueness follows the key. The new index is created BEFORE the old
    //    one goes, so a crash in between leaves the stricter pair in force
    //    rather than none.
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_datatables_scope_key
                   ON datatables(scope_kind, scope_id, lower(key))`);
    await run(`CREATE INDEX IF NOT EXISTS idx_datatables_scope ON datatables(scope_kind, scope_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_dt_usage_scope ON automation_datatable_usage(scope_kind, scope_id)`);
    await run(`DROP INDEX IF EXISTS uq_datatables_org_key`);

    // 8. The metadata backstop. A foreign key cannot drop a Postgres schema, so
    //    stores/user/organizations.js still owns the explicit row teardown —
    //    but the mechanism that produced the Art. 17 gap was "a new feature
    //    forgot to update deleteOrganization", and this half becomes impossible
    //    to forget. Valid only now that the column is nullable: a personal
    //    table has no organisation to point at.
    const orgs = await getOne(`SELECT to_regclass('organizations') AS t`).catch(() => null);
    if (orgs?.t) {
        const fk = await getOne(
            `SELECT 1 AS present FROM pg_constraint
              WHERE conname = 'fk_datatables_organization' AND conrelid = 'datatables'::regclass`,
        ).catch(() => null);
        if (!fk?.present) {
            // NOT VALID would skip the scan of existing rows, but it would also
            // leave rows naming a deleted organisation behind for ever. The
            // table is small (one row per datatable) and a full check is cheap.
            await run(`ALTER TABLE datatables
                         ADD CONSTRAINT fk_datatables_organization
                         FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE`)
                .catch((e) => {
                    // A deployment with rows naming an organisation that is
                    // already gone cannot take the constraint. Say so — the
                    // scope migration itself has already landed, and the FK is
                    // a backstop, not the mechanism.
                    console.warn(`[Migration] datatable-scope: could not add the organizations FK: ${e.message}`);
                });
        }
    }
}

module.exports = { up, pkCovers };
