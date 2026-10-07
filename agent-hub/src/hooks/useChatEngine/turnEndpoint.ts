/**
 * Where a chat turn goes, and which counted chat type that endpoint is.
 *
 * One function decides the path for the chat engine AND for the screen that
 * announces chat signals, so the notice above a composer and the marker on
 * its request describe the same endpoint by construction. Only the two
 * endpoints the server counts map to a chat type; the webpage, template,
 * notebook and every custom endpoint map to none, so they never carry a
 * marker and are never counted.
 */

export const DIRECT_TURN_PATH = '/ai/chat/direct/stream';

const AGENT_TURN_RE = /^\/agents\/[^/?#]+\/chat\/stream$/;

export type ChatSignalsTurnSurface = 'direct' | 'agent';

export interface TurnEndpointInput {
    isDirectMode: boolean;
    customEndpoint?: string | null;
    agentId?: string | null;
}

/** The turn's path without API_BASE, exactly as the engine posts to it. */
export function resolveTurnEndpoint({ isDirectMode, customEndpoint, agentId }: TurnEndpointInput): string {
    if (isDirectMode) return customEndpoint || DIRECT_TURN_PATH;
    return `/agents/${agentId}/chat/stream`;
}

/** 'direct' or 'agent' for the two counted endpoints; null for every other path. */
export function chatSignalsSurfaceFor(path: string | null | undefined): ChatSignalsTurnSurface | null {
    if (path === DIRECT_TURN_PATH) return 'direct';
    if (typeof path === 'string' && AGENT_TURN_RE.test(path)) return 'agent';
    return null;
}
