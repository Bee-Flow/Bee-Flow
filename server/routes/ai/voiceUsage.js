// @typecheck strict
/**
 * Voice chat: the usage row of one turn (routes/ai/voice.js, source `voice`,
 * core/llm/surfaceUsage.js).
 */

'use strict';

const { logSurfaceUsage } = require('../../core/llm/surfaceUsage');

/**
 * The part of the request the meter reads: the signed-in person.
 * @typedef {{ session?: { user?: { id?: string | null, organizationId?: string | null } | null } | null }} VoiceTurnRequest
 */

/**
 * @typedef {{ model: string, usage: unknown, startedAt: number, agentId: string | null }} VoiceTurnUsage
 */

/**
 * One usage row per voice turn: the signed-in person, their organisation,
 * the agent when one was chosen, the model and the tokens of every round.
 * @param {VoiceTurnRequest} req
 * @param {VoiceTurnUsage} turn
 * @returns {void}
 */
function meterVoiceTurn(req, { model, usage, startedAt, agentId }) {
    const user = req.session?.user;
    logSurfaceUsage({
        source: 'voice', userId: user?.id || null, orgId: user?.organizationId || null,
        agentId, model, usage, startedAt,
    });
}

module.exports = { meterVoiceTurn };
