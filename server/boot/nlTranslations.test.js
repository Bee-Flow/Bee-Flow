// @typecheck strict
/**
 * The Dutch catalogues run in sequence, every name in the list is real, and
 * startupTasks actually delegates to the shared ladder.
 *
 * History, in two moves:
 *
 * 1. The catalogues used to be one setImmediate each. Each add-nl-* migration
 *    does a read-modify-write of the same 'nl' translations blob, so fired in
 *    parallel two catalogues with work to do read one snapshot and the later
 *    write dropped the earlier one's keys. The list became one sequential loop.
 * 2. U1 moved that list out of startupTasks.js into boot/bootMigrations.js so
 *    `npm run db:migrate` runs the SAME ladder instead of silently skipping
 *    the whole category. This test moved with it — and gained the assertion
 *    that startupTasks still calls the shared runner, because a list that
 *    nothing invokes is exactly the bug the ladder existed to end.
 *
 * Reads startupOneShots.js and migrateDb.js as SOURCE: booting the real thing
 * would start every scheduler in the process. The runner's sequence is run
 * through its load / ledger seam, and for real (against Postgres) in
 * migrateDb.integration.test.js.
 *
 * Run: node --test --test-force-exit boot/nlTranslations.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// runStartupTasks() calls its one-shot phase from startupOneShots.js.
const STARTUP = fs.readFileSync(path.join(__dirname, 'startupOneShots.js'), 'utf8');
const { NL_TRANSLATIONS, LOOSE_MIGRATIONS, runNlTranslations } = require('./bootMigrations');

test('the list is found and non-trivial', () => {
    assert.ok(Array.isArray(NL_TRANSLATIONS) && NL_TRANSLATIONS.length >= 10,
        'expected the full set of Dutch catalogues in bootMigrations.js');
});

test('every listed migration exists on disk', () => {
    const missing = [...NL_TRANSLATIONS, ...LOOSE_MIGRATIONS]
        .filter(n => !fs.existsSync(path.join(__dirname, '..', 'migrations', `${n}.js`)));
    assert.deepEqual(missing, [], `the ladder names no such migration: ${missing.join(', ')}`);
});

test('no catalogue silently falls out of the boot list', () => {
    // The contract worth pinning: these ran at boot before the extraction, and
    // dropping one would quietly return a surface to English.
    const EXPECTED = [
        'add-nl-signup-mfa-reset-auth-translations',
        'add-nl-signup-welcome-neutral-translation',
        'add-nl-login-email-relabel',
        'add-nl-org-registration-source',
        'add-nl-voiceprint-translations',
        'add-nl-approvals-translations',
        'add-nl-solution-membership-translations',
        'add-nl-personal-privacy-shield-translations',
        'add-nl-routines-nodes-translations',
        'add-nl-cowork-translations',
    ];
    const dropped = EXPECTED.filter(n => !NL_TRANSLATIONS.includes(n));
    assert.deepEqual(dropped, [], `no longer run at boot: ${dropped.join(', ')}`);
});

test('they are awaited in one loop, not fired as parallel setImmediates', async () => {
    // The original fix. If someone "simplifies" runList back to one
    // setImmediate per migration, the clobbering returns and nothing else
    // would catch it.
    //
    // The runner itself, through its load / ledger seam: every catalogue is
    // still running when it yields, so two at once would show as more than one
    // active. (migrateDb.integration.test.js runs the real ladder against Postgres.)
    let active = 0;
    let most = 0;
    /** @type {string[]} */
    const ran = [];
    await runNlTranslations({
        log: { warn() {}, log() {} },
        ledger: { read: async () => new Map(), record: async () => {} },
        load: (name) => ({
            up: async () => {
                active += 1;
                most = Math.max(most, active);
                await new Promise((resolve) => setImmediate(resolve));
                ran.push(name);
                active -= 1;
            },
        }),
    });
    assert.equal(most, 1, 'two catalogues ran at the same time');
    assert.deepEqual(ran, NL_TRANSLATIONS, 'the catalogues ran out of order, or not all of them');
    // What the runner cannot show: a per-migration setImmediate back in
    // startupOneShots.js (one phase of runStartupTasks(), which fires every other
    // boot scheduler), so that file is read as text.
    for (const name of NL_TRANSLATIONS) {
        const perMigration = new RegExp(
            `setImmediate\\(\\(\\) => \\{\\s*require\\('\\.\\./migrations/${name}'\\)`,
        );
        assert.ok(
            !perMigration.test(STARTUP),
            `${name} has its own setImmediate again — that is the race this file exists for`,
        );
    }
});

test('startupTasks delegates to the shared ladder — a list nothing invokes is the old bug', () => {
    // Genuinely textual, same reason as above: proving this by calling the
    // real runStartupTasks() would boot every other scheduler in the process
    // (see its own docblock). migrateDb.integration.test.js already proves
    // migrateDb.js's half of this behaviourally, end to end against real
    // Postgres; the startupTasks half has no such counterpart because running
    // it for real is exactly what this file exists to avoid.
    assert.match(STARTUP, /require\('\.\/bootMigrations'\)\.runNlTranslations\(\)/,
        'startupTasks no longer runs the NL catalogues');
    assert.match(STARTUP, /require\('\.\/bootMigrations'\)\.runLooseMigrations\(\)/,
        'startupTasks no longer runs the loose data migrations');
    // And migrateDb runs the same ladder — that was the point of extracting it.
    const MIGRATE = fs.readFileSync(path.join(__dirname, '..', 'migrateDb.js'), 'utf8');
    assert.match(MIGRATE, /runLooseMigrations|runNlTranslations/,
        'migrateDb.js no longer runs the boot ladder');
});
