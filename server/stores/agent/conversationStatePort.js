// @typecheck strict
// Deleting a conversation also drops what core/dlp keeps for it (the Privacy
// Shield token map and the remembered choice), so a reused id starts clean.
// That state is owned by core/dlp/dlpRunner, and a store may not require core:
// boot/lateBoundPorts.js installs the cleaner (the server loads it at boot, and
// so does a script that changes users or organisations); the two delete
// functions only call it.

const log = require('../../telemetry/log');

let warned = false;
/** @type {(conversationId: string) => unknown} */
let clean = () => {
    // Not silent: without the port a deleted conversation keeps its cached state.
    if (!warned) { warned = true; log.warn('[conversationState] cleaner not installed: require boot/lateBoundPorts in this entry point'); }
};

/** @param {(conversationId: string) => unknown} fn */
function setConversationStateCleaner(fn) { clean = fn; }

/** @param {string} conversationId */
function clearConversationState(conversationId) { return clean(conversationId); }

module.exports = { setConversationStateCleaner, clearConversationState };
