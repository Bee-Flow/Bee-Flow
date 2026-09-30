/** React Query keys for notifications. The hooks own them. */

export const notificationKeys = {
    all: ['notifications'] as const,
    list: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly] as const,
    /**
     * MUST stay `['notifications','unread']` — the header bell polls the badge
     * under exactly this key, and a mutation here has to be able to invalidate
     * it. Changing this string silently freezes the bell's count.
     */
    unread: ['notifications', 'unread'] as const,
};
