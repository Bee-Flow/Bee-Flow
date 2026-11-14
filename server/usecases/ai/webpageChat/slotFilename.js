// @typecheck strict
/**
 * The file name a webpage slot is shown under, to the model and in messages.
 */

'use strict';

/**
 * @param {string | undefined} slot
 */
function slotFilename(slot) {
    return slot === 'html' ? 'index.html' : slot === 'css' ? 'style.css' : 'script.js';
}

module.exports = { slotFilename };
