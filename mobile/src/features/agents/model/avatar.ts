/**
 * Agent avatars.
 *
 * A port of agent-hub/src/utils/agentAvatar.js, which exists there for the
 * same reason it exists here: one string column holds four different kinds of
 * value, and every consumer has to agree on how to tell them apart.
 *
 *   - an emoji            "🤖"
 *   - a data URL          "data:image/png;base64,…"
 *   - an absolute URL     "https://…"
 *   - a server-relative   "/uploads/agents/<id>.png"
 *
 * Getting the emoji case wrong is not a broken image icon — it is an <Image>
 * asked to load "🤖", which renders as nothing at all.
 */

import type { Agent } from './types';

export const DEFAULT_AGENT_EMOJI = '🤖';

/** True when the value should be loaded as an image rather than drawn as text. */
export function isImageAvatar(value: string | null | undefined): boolean {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        (value.startsWith('data:') || value.startsWith('http') || value.startsWith('/'))
    );
}

/**
 * Legacy agents kept their picture in `config.avatar` instead of the dedicated
 * column. New writes go to the column; reads fall through so existing pictures
 * do not disappear before the backfill runs.
 */
export function pickAgentAvatar(agent: Pick<Agent, 'avatar' | 'config'> | null | undefined): string | null {
    if (!agent) return null;
    const fromConfig = typeof agent.config?.avatar === 'string' ? agent.config.avatar : null;
    return agent.avatar || fromConfig || null;
}
