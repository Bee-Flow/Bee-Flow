/**
 * Why the composer's Web search switch cannot work in the builder chat, or null.
 *
 * The composer hides the switch only on what it can see (provider disabled, the
 * org's integration list); the server also checks that a provider is really set
 * up, that this user may use web search, and the org's file policy, and reports
 * the outcome per turn (`web_search`). A switch the server refused is shown
 * disabled with this reason instead of looking on while doing nothing.
 *
 * 'off' is the user's own choice and needs no reason: the switch stays usable.
 */

import type { BuilderWebSearchStatus } from '../../../../hooks/useAutomationBuilderStream';

type Translate = (key: string, fallback: string) => string;

const REASONS: Record<string, { key: string; en: string }> = {
    not_configured: { key: 'automations.assistant.web_search_unavailable.not_configured', en: 'Web search is not set up on this server' },
    not_permitted: { key: 'automations.assistant.web_search_unavailable.not_permitted', en: 'Web search is not enabled for your account' },
    upload_policy: { key: 'automations.assistant.web_search_unavailable.upload_policy', en: 'Web search disabled by organisation policy (files attached)' },
    unavailable: { key: 'automations.assistant.web_search_unavailable.unavailable', en: 'Web search could not be checked; try again' },
};

export function webSearchUnavailableHint(status: BuilderWebSearchStatus | null | undefined, t: Translate): string | null {
    if (!status || !status.requested || status.available) return null;
    if (status.reason === 'off') return null;
    const r = REASONS[status.reason || ''] || REASONS.unavailable;
    return t(r.key, r.en);
}
