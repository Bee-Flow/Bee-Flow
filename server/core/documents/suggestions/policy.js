'use strict';

/**
 * Does an AI change to a document wait for a human (suggestions), or may it
 * be written directly?
 *
 * Direct write ONLY for a page the AI itself made in this chat that nobody
 * else can see or has open: not filed in a project, sharing private, no live
 * session. Everything else is proposed. Golf 2 covers pages; any other
 * docType keeps today's behaviour (false).
 *
 * @param {{ doc: { docType?: string, projectId?: string|null, visibility?: string, sharing?: { audience?: string } },
 *           createdInThisChat?: boolean, liveSession?: boolean }} input
 */
function shouldSuggest({ doc, createdInThisChat = false, liveSession = false } = /** @type {any} */ ({})) {
    if (!doc) return false;
    if (doc.docType && doc.docType !== 'page') return false;
    const audience = doc.sharing?.audience || (doc.visibility === 'team' ? 'organisation' : 'private');
    const directOk = createdInThisChat === true && !doc.projectId && audience === 'private' && !liveSession;
    return !directOk;
}

module.exports = { shouldSuggest };
