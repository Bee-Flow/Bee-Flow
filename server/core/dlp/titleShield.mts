/**
 * titleShield.mts: what the title model is sent for a conversation.
 *
 * The stored user messages can hold real values the Privacy Shield replaced
 * with tokens on their way to the chat model. The title call is another
 * outbound prompt, so it gets the same tokens (the conversation's token map,
 * no new ones minted), and the title it returns is shown with the real values
 * put back, as the chat itself is.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface TitleShieldDeps {
    tokenMapFor: (conversationId: string) => Promise<Record<string, string>>;
}

function defaultDeps(): TitleShieldDeps {
    return {
        tokenMapFor: (conversationId) => nodeRequire('./dlpRunner.js').getConversationTokenMapAsync(conversationId),
    };
}

/**
 * `text` with every known real value replaced by its token, and `restore`
 * for the generated title. Throws when the token map cannot be read: the
 * caller then skips the title instead of sending the raw text.
 */
export async function shieldTitleContext(conversationId: string | null, text: string, deps: Partial<TitleShieldDeps> = {}): Promise<{ text: string; restore: (title: string) => string }> {
    const identity = { text, restore: (title: string) => title };
    if (!conversationId) return identity;
    const d = { ...defaultDeps(), ...deps };
    const map = await d.tokenMapFor(conversationId);
    if (!map || Object.keys(map).length === 0) return identity;
    const { buildReverseReplacer } = nodeRequire('./applyTokenMapToOutbound.js');
    const { restoreTokens } = nodeRequire('../../utils/piiTokenRestore.js');
    const replace = buildReverseReplacer(map) as ((s: string) => string) | null;
    return {
        text: replace ? replace(text) : text,
        restore: (title: string) => (typeof title === 'string' ? restoreTokens(title, map) as string : title),
    };
}
