/**
 * Swap functions ON shared module objects for the length of a test file, and
 * put them back afterwards.
 *
 * Routes that call their store or a lookup through the module object at
 * request time (`automationStore.getAutomation(...)`, not a destructured
 * copy) can be tested this way without reaching into the module system
 * (`count-ratchet.mjs module-mock`): the object is the seam.
 *
 *   const { swap, restore } = makeSwaps();
 *   before(() => { swap(automationStore, 'getAutomation', async () => row); });
 *   after(restore);
 *
 * `swap` returns an undo for a swap that should last one test only:
 *
 *   const undo = swap(permissions, 'hasPermission', async () => true);
 *   try { ... } finally { undo(); }
 */

'use strict';

function makeSwaps() {
    const originals = [];

    function swap(obj, name, fn) {
        const entry = [obj, name, obj[name]];
        originals.push(entry);
        obj[name] = fn;
        return function undo() {
            const at = originals.indexOf(entry);
            if (at < 0) return;
            originals.splice(at, 1);
            obj[name] = entry[2];
        };
    }

    /** Put every swapped function back, the latest swap first. */
    function restore() {
        while (originals.length) {
            const [obj, name, fn] = originals.pop();
            obj[name] = fn;
        }
    }

    return { swap, restore };
}

module.exports = { makeSwaps };
