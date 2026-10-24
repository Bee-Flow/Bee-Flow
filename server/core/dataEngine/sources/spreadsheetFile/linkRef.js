const reading = require('./reading');

/**
 * The `ref` a refusal carries: the wire id, and the sheet it was about. The
 * id must be the one the browser handed out and the wizard keyed its rows
 * on — a `fileRefOf` ref (split from the client's id) has no `owned`, and it
 * carries a driveId ONLY when the client sent a composite `drive|item`, so
 * that is read back as "foreign drive" and the composite is re-emitted.
 */
function wireRef(provider, ref, sheet = null) {
    const owned = ref.owned === undefined ? !ref.driveId : ref.owned;
    return { provider, fileId: reading.wireIdOf({ ...ref, provider, owned }), ...(sheet ? { sheet } : {}) };
}

module.exports = { wireRef };
