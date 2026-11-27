// @typecheck strict
/**
 * Set-up for the "two tables land together or not at all" tests (stores/storeWrites.atomic*.pg.test.js):
 * a PGlite with the boot ladder's schema behind the real db.js, the stores' inits run in order, and
 * a trigger that makes one table refuse a write.
 *
 *   const { pg, refuse, count, REFUSED, setUp } = useRefusingPglite();
 *   const supportStore = require('./supportStore');        // after the pool, so it reaches it
 *   before(() => setUp([supportStore.initDB]));
 *   await refuse('support_threads', 'BEFORE UPDATE', `NEW.subject = '${REFUSED}'`);
 *
 * Call it before requiring the stores; the pool is closed after the file's tests.
 */

'use strict';

const { after } = require('node:test');
const { ladderPglite } = require('./pgliteTemplate');
const { usePglitePool } = require('./pglitePool');

const REFUSED = 'refused';

function useRefusingPglite() {
    const { pg, close } = usePglitePool(ladderPglite());
    after(close);

    /**
     * Run the stores' inits in order, then create the function the triggers raise with.
     * @param {Array<() => unknown>} inits
     */
    async function setUp(inits) {
        for (const init of inits) await init();
        await pg.exec(`
            CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'write refused';
            END $$;
        `);
    }

    /**
     * A trigger on `table` that raises for the rows `when` picks (a condition on NEW or OLD).
     * @param {string} table
     * @param {string} timing e.g. 'BEFORE UPDATE'
     * @param {string} when
     */
    async function refuse(table, timing, when) {
        const name = `refuse_${table}_${String(timing.split(' ')[1]).toLowerCase()}`;
        await pg.exec(`
            CREATE TRIGGER ${name} ${timing} ON ${table}
                FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION refuse_write();
        `);
    }

    /**
     * The `n` of the first row of a query.
     * @param {string} sql
     * @param {unknown[]} [params]
     */
    const count = async (sql, params = []) => Number(/** @type {{ n: unknown }} */ ((await pg.query(sql, params)).rows[0]).n);

    return { pg, refuse, count, REFUSED, setUp };
}

module.exports = { useRefusingPglite };
