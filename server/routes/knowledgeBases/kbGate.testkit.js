// @typecheck
/**
 * Stand-in knowledge-base gate for the route tests that mock `./shared` or
 * `../core/kb/kbAccess`: the REAL gate (auth/kbAccess.mts makeKbGates: the
 * 404 and 403 answers, what it leaves on `req.kbAccess`) over the test's own
 * verdicts.
 *
 *   './shared': {
 *       ...fakeKbGates({ kbStore: MOCKS['../../stores/knowledgeBases'], canRead: () => fx.canAccess, canManage: () => fx.canManage }),
 *       getUserId: (req) => req.session?.user?.id || null,
 *   },
 *
 * The verdicts are read per call, so a test flips them between requests. The
 * returned object also carries `canAccessKB` and `canManageKB` on the same
 * verdicts, for the handlers that still ask by hand (a list, a flag).
 *
 * Not a test file: required by *.test.js next to it. No test cases here.
 */

'use strict';

const { makeKbGates, kbAccessOf } = require('../../auth/kbAccess.mts');

/** @typedef {import('../../auth/kbAccess.mts').KbRow} KbRow */
/** @typedef {import('../../auth/kbAccess.mts').KbRequest} KbRequest */

/**
 * @param {{
 *   kbStore: { getKB: (id: string) => Promise<any> },
 *   canRead?: (kb: KbRow, req: KbRequest) => boolean | Promise<boolean>,
 *   canManage?: (kb: KbRow, req: KbRequest) => boolean | Promise<boolean>,
 *   userId?: (req: KbRequest) => string | null,
 * }} p  both verdicts default to true; `userId` to the session user
 */
function fakeKbGates({ kbStore, canRead = () => true, canManage = () => true, userId }) {
    const effectiveUserId = userId || ((/** @type {KbRequest} */ req) => req.session?.user?.id || null);
    const gates = makeKbGates({ getKB: (id) => kbStore.getKB(id), getUserId: effectiveUserId }, {
        gradeOf: async (req, kb) => {
            const [r, m] = await Promise.all([canRead(kb, req), canManage(kb, req)]);
            if (m) return 'manage';
            return r ? 'read' : null;
        },
    });
    return {
        ...gates,
        kbAccessOf,
        canAccessKB: async (/** @type {KbRequest} */ req, /** @type {KbRow} */ kb) => canRead(kb, req),
        canManageKB: async (/** @type {KbRequest} */ req, /** @type {KbRow} */ kb) => canManage(kb, req),
    };
}

module.exports = { fakeKbGates };
