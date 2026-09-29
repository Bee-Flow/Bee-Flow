/**
 * The first lines of every handler on one routine: read it, and check the
 * caller's role against what the route needs (automation/access.js guard).
 *
 *   const load = makeGuardedLoad(store, access);
 *   const loaded = await load(req, res, 'edit');
 *   if (!loaded) return;          // 404 or the guard's 403 is already sent
 *   const { a, acc } = loaded;
 */

'use strict';

/**
 * @param {() => { getAutomation(id: string): Promise<object|null> }} store the store, read per request
 * @param {{ guard(req: object, res: object, a: object, need: string): Promise<object|null> }} access
 */
function makeGuardedLoad(store, access) {
    return async function load(req, res, need) {
        const a = await store().getAutomation(req.params.id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return null; }
        const acc = await access.guard(req, res, a, need);
        if (!acc) return null;
        return { a, acc };
    };
}

module.exports = { makeGuardedLoad };
