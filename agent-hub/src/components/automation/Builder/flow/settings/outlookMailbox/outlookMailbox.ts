// Which Outlook mailbox an Outlook step or the Outlook "New email" trigger
// works on: the user's own (no value, or "me") or a shared mailbox's address.
// The server holds the rule that counts (core/integrations/outlookMailbox.mts:
// it re-checks the address, the connection's scopes and Microsoft's answer at
// every run); this copy only drives the picker's inline hint.

// Same shape as the server's: the App Studio connector's address pattern, and
// none of the characters that mean something in a URL.
const MAILBOX_RE = /^[^\s@"'<>\\/?#%&=]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}$/i;

/** The Outlook tools; every one of them takes the optional `mailbox`. */
export function isOutlookTool(tool: string | null | undefined): boolean {
    return typeof tool === 'string' && tool.startsWith('outlook_');
}

/** Is `text` a shared mailbox's address (as the server will accept it)? */
export function isMailboxAddress(text: string): boolean {
    return MAILBOX_RE.test(text.trim());
}

/** Does this value mean "the own mailbox"? */
export function isOwnMailbox(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && (value.trim() === '' || value.trim().toLowerCase() === 'me'));
}

interface LiteralBinding { kind: 'literal'; value?: unknown }

/**
 * What the picker can show for a step's `mailbox` binding: the address of a
 * written-out shared mailbox, '' for the own mailbox, or null when the value is
 * bound to data (a ref/template/expr) — the generic field shows that one.
 */
export function mailboxFromBinding(binding: unknown): string | null {
    if (binding === undefined || binding === null) return '';
    if (typeof binding === 'string') return isOwnMailbox(binding) ? '' : binding;
    const b = binding as Partial<LiteralBinding> & { kind?: unknown };
    if (b.kind !== 'literal') return null;
    return isOwnMailbox(b.value) ? '' : String(b.value);
}

/** The schema without `mailbox`: the picker above the form owns that field. */
export function withoutMailboxInput<T extends { properties?: Record<string, unknown>; required?: string[] } | null | undefined>(schema: T): T {
    if (!schema?.properties || !('mailbox' in schema.properties)) return schema;
    const properties = { ...schema.properties };
    delete properties.mailbox;
    const required = Array.isArray(schema.required) ? schema.required.filter((k: string) => k !== 'mailbox') : schema.required;
    return { ...schema, properties, required } as T;
}
