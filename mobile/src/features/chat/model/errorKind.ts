/**
 * What kind of failure an answer's error is — the heading of the web's error
 * card (MessageContentBody.jsx) and the words beside its timestamp
 * (MessageActionsRow.jsx), read off the server's sentence in the web's order.
 * Pinned by errorKind.lockstep.test.ts.
 *
 * A usage or subscription limit is not a malfunction: it gets the warning
 * tone and its own heading, because "try again" is the wrong advice for it.
 */

export interface ErrorKind {
    /** The heading: the web's key, this app's key and the English. */
    key: string;
    i18nKey: string;
    en: string;
    /** A limit or a subscription state rather than a fault. */
    limit: boolean;
}

/**
 * The headings, in the web's order. Each matches when EVERY word in `all`
 * occurs in the error; the first match wins, and the last one always does.
 *
 * `key` is the web's; it is in neither dictionary, so the phone renders its
 * own `i18nKey` (the same name under `mobile.chat.`) rather than asking the
 * catalogue for a key nobody can translate.
 *
 * There is no "Chat" + "type" heading (BFSF-184): it matched every provider
 * error relayed as `Chat error: ... {"type":...}`. The real per-type limit
 * says "message limit" and lands on that heading.
 */
export const ERROR_TITLES: readonly {
    all: readonly string[];
    any?: readonly string[];
    key: string;
    i18nKey: string;
    en: string;
}[] = [
    { all: ['suspended'], key: 'chat.msg.err_sub_suspended', i18nKey: 'mobile.chat.err_sub_suspended', en: 'Subscription Suspended' },
    { all: ['cancelled'], key: 'chat.msg.err_sub_cancelled', i18nKey: 'mobile.chat.err_sub_cancelled', en: 'Subscription Cancelled' },
    { all: ['message limit'], key: 'chat.msg.err_message_limit', i18nKey: 'mobile.chat.err_message_limit', en: 'Monthly Message Limit Reached' },
    { all: ['token limit'], key: 'chat.msg.err_token_limit', i18nKey: 'mobile.chat.err_token_limit', en: 'Monthly Token Limit Reached' },
    { all: ['cost limit'], key: 'chat.msg.err_cost_limit', i18nKey: 'mobile.chat.err_cost_limit', en: 'Monthly Cost Limit Reached' },
    { all: [], any: ['limit', 'subscription'], key: 'chat.msg.err_sub_limit', i18nKey: 'mobile.chat.err_sub_limit', en: 'Subscription Limit Reached' },
    { all: [], key: 'chat.msg.err_generic', i18nKey: 'mobile.chat.err_generic', en: 'Something went wrong' },
];

/** The words that make an error a limit (the card's amber tone). */
export const LIMIT_WORDS = ['limit', 'subscription', 'suspended', 'cancelled'] as const;

export function errorKindOf(text: string): ErrorKind {
    const title =
        ERROR_TITLES.find((t) => t.all.every((w) => text.includes(w)) && (!t.any || t.any.some((w) => text.includes(w)))) ??
        (ERROR_TITLES[ERROR_TITLES.length - 1] as (typeof ERROR_TITLES)[number]);
    return { key: title.key, i18nKey: title.i18nKey, en: title.en, limit: LIMIT_WORDS.some((w) => text.includes(w)) };
}
