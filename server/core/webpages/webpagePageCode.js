// @typecheck
const storageStore = require('../../stores/storageStore');
const webpageStore = require('../../stores/webpageStore');

/**
 * The code of the page, with an EXPLICIT readability flag.
 *
 * `webpageStore.readAllSlots` gives empty strings back when the object storage is
 * not available — not distinguishable from a page without script. Therefore
 * `storageStore.isAvailable()` is asked for here separately: without storage the answer is "unknown",
 * never "empty".
 *
 * The same rule applies to the extra files (see the header): if listing or reading them
 * fails, then the WHOLE outcome is unreadable. A page of which we could not fetch half of
 * the files may not yield "nothing found".
 *
 * `css` has been included since W4. The call scan does nothing with it, but the
 * element scan must have seen EVERY text file that the editor shows: a slot that is
 * not read cannot yield a marking, and that is not distinguishable from "nothing is here".
 *
 * @returns {Promise<{readable:boolean, html:string, css:string, js:string, extras:Array<{path:string,text:string}>}>}
 */
async function readPageCode(userId, webpageId) {
    const unreadable = { readable: false, html: '', css: '', js: '', extras: [] };
    try {
        if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) return unreadable;
    } catch { return unreadable; }
    let slots = null;
    try { slots = await webpageStore.readAllSlots(userId, webpageId); }
    catch { return unreadable; }
    if (!slots || typeof slots !== 'object') return unreadable;

    const extras = [];
    try {
        const metas = await webpageStore.listExtraFiles(webpageId);
        for (const meta of (Array.isArray(metas) ? metas : [])) {
            if (!meta || !meta.path) continue;
            // Binary extras (images, fonts) are not script source; they stand
            // as a blind spot in the header.
            if (!meta.isText) continue;
            const res = await webpageStore.readExtraFile({ webpageId, userId, path: meta.path });
            if (!res || typeof res.text !== 'string') return unreadable;
            extras.push({ path: String(meta.path), text: res.text });
        }
    } catch { return unreadable; }

    return {
        readable: true,
        html: String(slots.html || ''),
        css: String(slots.css || ''),
        js: String(slots.js || ''),
        extras,
    };
}

module.exports = { readPageCode };
