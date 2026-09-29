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
 * Reads both files as SOURCE — the list is data, and booting the real thing
 * would start every scheduler in the process. runList() itself is behaviour
 * and is exercised for real (against Postgres) in migrateDb.integration.test.js.
 *
 * Run: node --test --test-force-exit boot/nlTranslations.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LADDER = fs.readFileSync(path.join(__dirname, 'bootMigrations.js'), 'utf8');
const STARTUP = fs.readFileSync(path.join(__dirname, 'startupTasks.js'), 'utf8');
const { NL_TRANSLATIONS, LOOSE_MIGRATIONS } = require('./bootMigrations');

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

test('they are awaited in one loop, not fired as parallel setImmediates', () => {
    // The original fix. If someone "simplifies" runList back to one
    // setImmediate per migration, the clobbering returns and nothing else
    // would catch it.
    //
    // Genuinely textual, and deliberately not converted: runList's real
    // sequential behaviour (await, one at a time, ledger-recorded) is already
    // exercised for real against Postgres in migrateDb.integration.test.js —
    // that suite runs the actual ladder and checks the resulting schema, which
    // is strictly stronger evidence than a unit test could give without
    // reimplementing that same integration harness. What THIS test guards
    // that the integration suite cannot is the regression itself: someone
    // reintroducing a per-migration `setImmediate` in startupTasks.js — a 740-
    // line function that fires every other boot scheduler in the process, so
    // calling it for real here (even with bootMigrations stubbed) would mean
    // stubbing the rest of boot too, for a check the integration suite already
    // makes redundant for runList's own correctness.
    assert.match(LADDER, /for \(const name of names\)/, 'the sequential loop is gone');
    assert.match(LADDER, /await require\(/, 'the migrations are no longer awaited');
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
