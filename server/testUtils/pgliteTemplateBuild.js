// @typecheck strict
/**
 * Builds a pglite template (testUtils/pgliteTemplate.js) and publishes it to the
 * disk cache. A script, not a library: the ladder template installs a db.js mock
 * in require.cache, which must never leak into a test process, so it is always
 * built in a process of its own.
 *
 *   node testUtils/pgliteTemplateBuild.js --prepare        the empty one, unless cached
 *   node testUtils/pgliteTemplateBuild.js --build empty    (re)build one
 *   node testUtils/pgliteTemplateBuild.js --build ladder
 */

'use strict';

const { PGlite } = require('@electric-sql/pglite');
const { templateFile, readVerified, writeAtomic } = require('./pgliteTemplate');

/** @param {'empty' | 'ladder'} kind */
async function build(kind) {
    const file = templateFile(kind);
    /** @type {import('@electric-sql/pglite').PGlite} */
    let pg;
    if (kind === 'empty') {
        pg = new PGlite();
    } else {
        // The mock must be installed before anything requires db.js.
        const { usePgliteLadder } = require('./pgliteLadderDb');
        const ladder = usePgliteLadder();
        await ladder.runLadder();
        pg = ladder.pg;
    }
    await pg.waitReady;
    // Let detached store work (backfills the inits start and do not await) finish
    // or yield, so the snapshot is of a settled database.
    for (let i = 0; i < 5; i++) { await pg.query('SELECT 1'); await new Promise((r) => setTimeout(r, 50)); }
    const dump = await pg.dumpDataDir('gzip');
    writeAtomic(file, Buffer.from(await dump.arrayBuffer()));
    // No pg.close(): detached store work can keep a closing PGlite busy; the process ends below.
}

const args = process.argv.slice(2);
const kinds = args[0] === '--prepare' ? ['empty'] : args[0] === '--build' ? [args[1]] : [];
if (!kinds.length || kinds.some((k) => k !== 'empty' && k !== 'ladder')) {
    console.error('usage: pgliteTemplateBuild.js --prepare | --build empty|ladder');
    process.exit(2);
}
(async () => {
    for (const kind of /** @type {Array<'empty' | 'ladder'>} */ (kinds)) {
        if (args[0] === '--prepare' && readVerified(templateFile(kind))) continue;
        await build(kind);
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
