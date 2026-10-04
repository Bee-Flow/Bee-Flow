/**
 * The managed-write lock on automations of a Solution stage, against a real
 * Postgres (@electric-sql/pglite, in-process). The store functions run over
 * the PGlite handle (updateAutomationWith, makeLifecycleStore, makeSharesStore,
 * publishBlockVersionWith, the Step and builder-session `...With` variants); the guard is stores/lib/managedParts.js built with
 * which project is a stage, and the capability check is the real
 * solutionStageStore.isActiveDeployment over the same database. No module
 * mocking.
 *
 * Pinned:
 *   - a definition write on a managed automation is refused (409 managed_part);
 *   - the update set activation writes on a deployed automation (isActive,
 *     isDraft, needsFirstRunConfirm, nextRunAt, runTimeoutMs; from the real
 *     goLive.planGoLive) passes without a capability;
 *   - switching ON a managed automation that was never live is refused (it would
 *     publish the working copy) and passes with a capability; switching it OFF
 *     through the real deactivateCore passes;
 *   - a capability of a finished deployment, or of another stage, is refused;
 *   - publish, trash and owner transfer are refused; publishing with the
 *     capability on the commit client works;
 *   - a goLive write is a publish whatever keys it carries: refused without
 *     a capability, even when every key is on the allow-list;
 *   - publishBlockVersionWith flips published_version and writes the missing
 *     version snapshot;
 *   - a Step of a stage: publishStep and setStepExpose are refused,
 *     setStepSharing (a sharing key) passes;
 *   - the AI builder session of a managed automation is refused;
 *   - an unmanaged automation is never refused.
 *
 * Run: cd server && node --test stores/automationStore/managedLock.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');

const { up } = require('../../migrations/automation-handoff5-2026-09');
const { updateAutomationWith, deleteAutomationWith } = require('./automations');
const { makeLifecycleStore } = require('./lifecycle');
const { makeSharesStore } = require('./shares');
const { publishBlockVersionWith, publishStepWith, setStepSharingWith, setStepExposeWith } = require('./steps');
const { setBuilderSessionWith } = require('./builderSessions');
const { makeManagedParts } = require('../lib/managedParts');
const { makeSolutionStageStore, applySolutionStageSchema } = require('../solutionStageStore');
const { planGoLive, deactivateCore } = require('../../automation/goLive');

const { pg, db } = pgliteDb();

// Which project is a stage: 'stage_uat' is the UAT of Solution 'dev1'.
const STAGES = { stage_uat: { solutionId: 'dev1', stage: 'uat', projectId: 'stage_uat' } };
const stages = makeSolutionStageStore(db);
const managedParts = makeManagedParts({
    stageOfProject: async (id) => STAGES[id] || null,
    stageOfProjectFresh: async (id) => STAGES[id] || null,
    isActiveDeployment: (dep, projectId, client) => stages.isActiveDeployment(dep, projectId, client),
});

const lifecycle = makeLifecycleStore(db, { managedParts });
const shares = makeSharesStore(db, { managedParts });
const update = (id, updates, opts = {}) => updateAutomationWith(db, id, updates, 'u1', { managedParts, ...opts });

const DEF = { trigger: { kind: 'manual', id: 't' }, steps: [{ id: 's1', type: 'note', text: 'hi' }] };
const SCHEDULED = {
    trigger: { kind: 'schedule', id: 't', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } },
    steps: [{ id: 's1', type: 'note', text: 'hi' }],
    runPolicy: { timeoutMinutes: 5 },
};

async function seed(id, { projectId = 'stage_uat', live = null, kind = 'automation', definition = DEF, active = false } = {}) {
    await pg.query(
        `INSERT INTO automations (id, user_id, kind, title, definition_json, version, is_active, is_draft,
                                  project_id, live_version, live_definition_json, live_at)
         VALUES ($1, 'runas', $2, $1, $3, 3, $4, TRUE, $5, $6, CASE WHEN $6::int IS NULL THEN NULL ELSE $3::jsonb END,
                 CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() END)`,
        [id, kind, JSON.stringify(definition), active, projectId, live],
    );
}

/** A deployment row as admission and the runner leave it, bypassing both. */
async function deployment(id, status, stageProjectId = 'stage_uat') {
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan,
                                           plan_hash, stage_settings_version, request_key, requested_by)
         VALUES ($1, 'dev1', $2, 'uat', 'rel_1', 'deploy', $3, '{}'::jsonb, 'h', 1, $1, 'alice')`,
        [id, stageProjectId, status],
    );
}

const row = async (id) => (await pg.query('SELECT * FROM automations WHERE id = $1', [id])).rows[0];

const isManagedPart = (err) => {
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.code, 'managed_part');
    assert.strictEqual(err.expose, true);
    assert.deepStrictEqual(err.details, { solutionId: 'dev1', stage: 'uat' });
    return true;
};

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            kind TEXT NOT NULL DEFAULT 'automation',
            title TEXT NOT NULL,
            description TEXT,
            icon TEXT,
            category TEXT,
            definition_json JSONB NOT NULL,
            builder_session JSONB,
            version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            is_draft BOOLEAN NOT NULL DEFAULT TRUE,
            needs_first_run_confirm BOOLEAN NOT NULL DEFAULT TRUE,
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            schedule_cron TEXT,
            schedule_tz TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
            next_run_at TIMESTAMPTZ,
            last_run_at TIMESTAMPTZ,
            last_status TEXT,
            run_timeout_ms INTEGER,
            project_id TEXT,
            folder_id TEXT,
            published_version INTEGER,
            is_published BOOLEAN NOT NULL DEFAULT FALSE,
            shared_groups JSONB,
            expose_as_tool BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_versions (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            definition_json JSONB NOT NULL,
            saved_by_user_id TEXT NOT NULL,
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            change_summary TEXT,
            UNIQUE (automation_id, version)
        );
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            finished_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_run_steps (
            run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            step_type TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (run_id, step_id, attempts)
        );
    `);
    await up({ exec: (sql) => pg.exec(sql) });
    await applySolutionStageSchema({
        runDdl: async (_tag, statements) => {
            for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
        },
    });
    await deployment('dep_active', 'committing');
    await deployment('dep_done', 'succeeded');
});

after(async () => { await pg.close(); });

test('a definition write on a managed automation is refused, and the row stays as it was', async () => {
    await seed('r_def', { live: 3 });
    await assert.rejects(update('r_def', { definition: { ...DEF, steps: [] } }), isManagedPart);
    await assert.rejects(update('r_def', { title: 'Renamed' }), isManagedPart);
    const r = await row('r_def');
    assert.strictEqual(r.title, 'r_def');
    assert.strictEqual(r.version, 3, 'no version was written');
});

test('the activation update set passes on a deployed managed automation without a capability', async () => {
    await seed('r_act', { live: 3, definition: SCHEDULED });
    const plan = planGoLive({ triggerType: 'schedule', scheduleCron: '0 9 * * 1', scheduleTz: 'Europe/Amsterdam' },
        SCHEDULED, { willBeActive: true, verb: 'activate' });
    assert.ok(plan.ok);
    // What goLive.activateCore writes for an automation that already has a live copy.
    const updates = { isActive: true, needsFirstRunConfirm: false, ...plan.columns };
    assert.deepStrictEqual(Object.keys(updates).sort(),
        ['isActive', 'isDraft', 'needsFirstRunConfirm', 'nextRunAt', 'runTimeoutMs']);
    const out = await update('r_act', updates);
    assert.strictEqual(out.isActive, true);
    assert.strictEqual(out.isDraft, false);
    assert.strictEqual((await row('r_act')).run_timeout_ms, plan.columns.runTimeoutMs);
    // Scheduler bookkeeping and filing in a sidebar folder pass too.
    await update('r_act', { lastStatus: 'success', folderId: 'f1' });
});

test('switching on a managed automation that was never live needs the capability', async () => {
    await seed('r_new');
    await assert.rejects(update('r_new', { isActive: true }), isManagedPart);
    assert.strictEqual((await row('r_new')).is_active, false);

    const out = await update('r_new', { isActive: true }, { managedWrite: { deploymentId: 'dep_active' } });
    assert.strictEqual(out.isActive, true);
    // LIVE_INVARIANT_SQL published the working copy in the same write.
    assert.strictEqual((await row('r_new')).live_version, 3);
});

test('switching off a never-live managed automation passes, through the real deactivateCore', async () => {
    await seed('r_off', { active: true });
    const store = {
        deleteSubscriptionsForAutomation: async () => {},
        updateAutomation: (id, updates, actorId) => updateAutomationWith(db, id, updates, actorId, { managedParts }),
    };
    const { automation } = await deactivateCore({
        automation: { id: 'r_off', userId: 'runas' }, actorId: 'operator',
        deps: { store, revokeRemoteSubscriptions: async () => {}, wakeComplianceReview: () => {} },
    });
    assert.strictEqual(automation.isActive, false);
});

test('a capability of a finished deployment, or of another stage, is refused', async () => {
    await seed('r_cap', { live: 3 });
    await assert.rejects(update('r_cap', { title: 'x' }, { managedWrite: { deploymentId: 'dep_done' } }), isManagedPart);
    await assert.rejects(update('r_cap', { title: 'x' }, { managedWrite: { deploymentId: 'dep_nope' } }), isManagedPart);
    await deployment('dep_other', 'preparing', 'stage_prd');
    await assert.rejects(update('r_cap', { title: 'x' }, { managedWrite: { deploymentId: 'dep_other' } }), isManagedPart);

    const out = await update('r_cap', { title: 'From the release' }, { managedWrite: { deploymentId: 'dep_active' } });
    assert.strictEqual(out.title, 'From the release');
});

test('filing an automation into, or out of, a stage project needs the capability', async () => {
    await seed('r_file_in', { projectId: null });
    await assert.rejects(update('r_file_in', { projectId: 'stage_uat' }), isManagedPart);
    await seed('r_file_out', { live: 3 });
    await assert.rejects(update('r_file_out', { projectId: null }), isManagedPart);
});

test('publish, trash and restore are refused on a managed automation; the commit client publishes with the capability', async () => {
    await seed('r_pub', { live: 2 });
    await assert.rejects(lifecycle.publishWorkingCopy('r_pub', { expectedVersion: 3 }), isManagedPart);
    await assert.rejects(lifecycle.trashAutomation('r_pub', 'operator'), isManagedPart);
    await assert.rejects(lifecycle.restoreAutomation('r_pub'), isManagedPart);
    assert.strictEqual((await row('r_pub')).live_version, 2);
    assert.strictEqual((await row('r_pub')).deleted_at, null);

    const published = await db.tx(async (client) => makeLifecycleStore(client, { managedParts })
        .publishWorkingCopy('r_pub', { expectedVersion: 3, columns: { isDraft: false }, managedWrite: { deploymentId: 'dep_active' } }));
    assert.strictEqual(published.liveVersion, 3);
});

test('the owner of a managed automation never moves by hand', async () => {
    await seed('r_own', { live: 3 });
    await assert.rejects(shares.transferAutomationOwner('r_own', { fromUserId: 'runas', toUserId: 'mallory', byUserId: 'mallory' }),
        isManagedPart);
    assert.strictEqual((await row('r_own')).user_id, 'runas');
    const shared = await pg.query('SELECT COUNT(*)::int AS n FROM automation_shares WHERE automation_id = $1', ['r_own']);
    assert.strictEqual(shared.rows[0].n, 0, 'the refused transfer wrote no share');
});

test('a goLive write on a managed automation is a publish, whatever keys it carries', async () => {
    await seed('r_golive', { live: 2 });
    await assert.rejects(update('r_golive', { isDraft: false }, { goLive: true }), isManagedPart);
    await assert.rejects(update('r_golive', { isActive: false }, { goLive: true }), isManagedPart);
    assert.strictEqual((await row('r_golive')).live_version, 2, 'the working copy was not published');
    // The same keys without goLive are the allow-list.
    await update('r_golive', { isDraft: false });
    const out = await update('r_golive', { isDraft: false }, { goLive: true, managedWrite: { deploymentId: 'dep_active' } });
    assert.strictEqual(out.liveVersion, 3);
});

test('publishBlockVersionWith flips published_version and writes the missing snapshot', async () => {
    await seed('b_1', { kind: 'block' });
    await assert.rejects(publishBlockVersionWith(db, 'b_1', { managedParts }), isManagedPart);
    assert.strictEqual((await row('b_1')).published_version, null);

    const out = await db.tx((client) => publishBlockVersionWith(client, 'b_1', {
        managedParts, managedWrite: { deploymentId: 'dep_active' },
    }));
    assert.strictEqual(out.publishedVersion, 3);
    assert.strictEqual((await row('b_1')).version, 3, 'the version counter does not move');
    const snap = await pg.query('SELECT definition_json FROM automation_versions WHERE automation_id = $1 AND version = 3', ['b_1']);
    assert.deepStrictEqual(snap.rows[0].definition_json, DEF);
    assert.strictEqual(await publishBlockVersionWith(db, 'missing', { managedParts }), null);
});

test('an unmanaged automation is never refused', async () => {
    await seed('r_free', { projectId: 'some_project' });
    const out = await update('r_free', { title: 'Mine', isActive: true });
    assert.strictEqual(out.title, 'Mine');
    await seed('b_free', { kind: 'block', projectId: null });
    assert.strictEqual((await publishBlockVersionWith(db, 'b_free', { managedParts })).publishedVersion, 3);
    assert.ok(await lifecycle.trashAutomation('r_free', 'u1'));
});

test('deleting a managed automation is refused and keeps the row; an unmanaged one goes', async () => {
    await seed('r_del', { live: 3 });
    await assert.rejects(db.tx((client) => deleteAutomationWith(client, 'r_del', { managedParts })), isManagedPart);
    assert.ok(await row('r_del'));

    await seed('r_del_free', { projectId: null });
    assert.strictEqual(await db.tx((client) => deleteAutomationWith(client, 'r_del_free', { managedParts })), true);
    assert.strictEqual(await row('r_del_free'), undefined);
    assert.strictEqual(await db.tx((client) => deleteAutomationWith(client, 'r_missing', { managedParts })), false);
});

test('a Step of a stage: publish and tool exposure are refused, sharing passes', async () => {
    await seed('b_stage', { kind: 'block' });
    await assert.rejects(db.tx((client) => publishStepWith(client, 'b_stage', 'operator', { managedParts })), isManagedPart);
    await assert.rejects(setStepExposeWith(db, 'b_stage', true, { managedParts }), isManagedPart);
    let r = await row('b_stage');
    assert.strictEqual(r.published_version, null);
    assert.strictEqual(r.version, 3);
    assert.strictEqual(r.expose_as_tool, false);

    assert.strictEqual(await setStepSharingWith(db, 'b_stage', { isPublished: true, sharedGroups: ['g1'] }, { managedParts }), true);
    r = await row('b_stage');
    assert.strictEqual(r.is_published, true);
    assert.deepStrictEqual(r.shared_groups, ['g1']);

    const published = await db.tx((client) => publishStepWith(client, 'b_stage', 'operator', {
        managedParts, managedWrite: { deploymentId: 'dep_active' },
    }));
    assert.strictEqual(published.publishedVersion, 4);
    assert.strictEqual(await setStepExposeWith(db, 'b_stage', true, { managedParts, managedWrite: { deploymentId: 'dep_active' } }), true);
    assert.strictEqual(await setStepExposeWith(db, 'b_missing', true, { managedParts }), false);
});

test('the AI builder session of a managed automation is refused; an unmanaged one is written', async () => {
    const snap = { sessionId: 'bs_1', draft: DEF, conversation: [] };
    await seed('r_bs', { live: 3 });
    await assert.rejects(db.tx((client) => setBuilderSessionWith(client, 'r_bs', 'runas', snap, { managedParts })), isManagedPart);
    assert.strictEqual((await row('r_bs')).builder_session, null);

    await seed('r_bs_free', { projectId: null });
    const out = await db.tx((client) => setBuilderSessionWith(client, 'r_bs_free', 'runas', snap, { managedParts }));
    assert.strictEqual(out.ok, true);
    assert.strictEqual((await row('r_bs_free')).builder_session.version, 1);
});
