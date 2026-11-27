/**
 * What the AI does with a message in Bee Flow's own company inbox (the threads
 * without an inbox row: the website contact form and in-app tickets). Stored
 * in the configStore key `support_ai_reply_mode`, set under Admin → Support
 * inbox → Settings → AI behaviour.
 *
 *   off   — no model sees the message: no reply, no knowledge-base search, no
 *           tagging. The thread goes straight to staff.
 *   draft — the AI writes a reply as an internal note for staff; nothing is sent
 *           to the customer. Same meaning as `draft` on a tenant inbox.
 *   auto  — the AI answers the customer itself and hands off when it is not
 *           confident (the behaviour before this setting existed, and still the
 *           default while nothing is stored). The responder runs it as its
 *           `legacy` reply mode.
 *
 * Tenant inboxes keep their own per-inbox `reply_mode` (draft, auto_confident,
 * autonomous); this setting does not touch them.
 */

export const COMPANY_AI_REPLY_MODE_KEY = 'support_ai_reply_mode';

export const COMPANY_AI_REPLY_MODES = Object.freeze(['off', 'draft', 'auto'] as const);

export type CompanyAiReplyMode = typeof COMPANY_AI_REPLY_MODES[number];

export const DEFAULT_COMPANY_AI_REPLY_MODE: CompanyAiReplyMode = 'auto';

/** A stored value as a mode; anything unknown or missing is the default. */
export function normalizeCompanyAiReplyMode(raw: unknown): CompanyAiReplyMode {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return (COMPANY_AI_REPLY_MODES as readonly string[]).includes(value)
        ? value as CompanyAiReplyMode
        : DEFAULT_COMPANY_AI_REPLY_MODE;
}

/** The responder's reply mode for a company-inbox mode (`off` never reaches the responder's model path). */
export function responderModeFor(mode: CompanyAiReplyMode): 'off' | 'draft' | 'legacy' {
    if (mode === 'off') return 'off';
    if (mode === 'draft') return 'draft';
    return 'legacy';
}
