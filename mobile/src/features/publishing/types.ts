/**
 * Shapes for the three "published surface" screens: webpages, forms, MCP.
 *
 * Written from the server's own mappers rather than from the web client, which
 * hand-picks fields per component and would leave gaps here:
 *
 *   Webpage        server/stores/webpage/shared.js  → mapWebpageRow
 *   WebpageShare   server/stores/webpagePublicShareStore.js → mapRow
 *   FormSummary    server/routes/automation/crud.js GET /forms (assembled in
 *                  the handler, NOT a store row — it merges the page row with
 *                  the form trigger out of the automation definition)
 *   FormSubmission server/stores/automationStore/rowMappers.js → run mapper
 *   McpServer      server/stores/mcpStore.js → parseRow, which is `...row`:
 *                  raw snake_case straight off the table. api.ts maps it.
 *
 * Fields the phone never reads are left out on purpose — every one of them is
 * a promise about a payload, and an unused promise is one nobody checks.
 */

// ── Webpages ────────────────────────────────────────────────────────

export interface Webpage {
    id: string;
    /** The owner. `readOnly` on the detail response is derived from this. */
    userId: string;
    name: string;
    description: string;
    tagline: string;
    icon: string;
    accentColor: string;
    /** Visible to the owner's organisation (or to `sharedGroups` within it). */
    isPublished: boolean;
    sharedGroups: string[];
    organizationId: string | null;
    projectId: string | null;
    /** Byte sizes of the three content slots; all zero means nothing built yet. */
    htmlSize: number;
    cssSize: number;
    jsSize: number;
    sourceCount: number;
    createdAt: string | null;
    updatedAt: string | null;
}

/** GET /api/webpages/:id. `readOnly` is true for an org viewer, not the owner. */
export interface WebpageDetail {
    webpage: Webpage;
    readOnly: boolean;
}

/**
 * One external share link.
 *
 * `url` is null whenever the raw token is no longer recoverable — revoked,
 * expired, or a legacy row stored before tokens were encrypted at rest
 * (server/routes/webpageShareUrls.js attachShareUrls). That is not an error
 * state to retry: the link genuinely cannot be shown again, and the fix is a
 * new one.
 *
 * `allowedEmails` is stripped for anyone who is not the share's creator, so it
 * is optional here rather than nullable.
 */
export interface WebpageShare {
    id: string;
    webpageId: string;
    createdBy: string;
    accessMode: 'unlisted' | 'password' | 'email';
    hasPassword: boolean;
    allowedEmails?: string[] | null;
    expiresAt: string | null;
    revokedAt: string | null;
    title: string;
    viewCount: number;
    lastViewedAt: string | null;
    createdAt: string | null;
    url: string | null;
}

/** POST /api/webpages/:id/public-shares — the only time `url` is guaranteed. */
export interface CreatedWebpageShare {
    share: WebpageShare;
    url: string;
}

// ── Forms ───────────────────────────────────────────────────────────

/**
 * A hosted form, as GET /api/automation/forms assembles it.
 *
 * `id` is the form PAGE id — the token in the /f/<id> address — not the
 * automation's. Both are needed: the link is keyed by the page, everything
 * else (submissions, open/closed) is keyed by the routine behind it.
 *
 * `url` arrives as the bare path `/f/<id>`; publicFormUrl() in api.ts is what
 * makes it absolute.
 */
export interface FormSummary {
    id: string;
    url: string;
    automationId: string;
    triggerStepId: string | null;
    title: string;
    description: string | null;
    /** `isActive && !isDraft` — both have to hold or the link 404s. */
    live: boolean;
    submissions: number;
    lastSeenAt: string | null;
    createdAt: string | null;
    /** Whether the caller owns the routine. The automation endpoints are per-user. */
    mine: boolean;
}

/**
 * One submission — an automation run whose trigger was the form.
 *
 * `triggerPayload` is the answers object exactly as coerceSubmission built it
 * (routes/automation/formPublic.js): field id → value, where a file answer is
 * a `{ kind: 'form_upload', filename, … }` object rather than a scalar.
 */
export interface FormSubmission {
    id: string;
    automationId: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    triggerKind: string | null;
    triggerPayload: unknown;
    summary: string | null;
    error: string | null;
}

// ── MCP ─────────────────────────────────────────────────────────────

/** One tool a server advertised at discovery time. */
export interface McpTool {
    name: string;
    description?: string;
}

/**
 * A configured MCP server, camelCased from the raw row.
 *
 * `status` is written by mcpManager as it probes: 'ready' once tools were
 * discovered, 'pending_credentials' when the server needs a secret nobody has
 * supplied yet, 'error' with `error` set, and 'disconnected' as the column
 * default for a row that has never been probed at all.
 */
export interface McpServer {
    id: string;
    name: string;
    description: string;
    icon: string;
    enabled: boolean;
    status: 'ready' | 'pending_credentials' | 'error' | 'disconnected' | string;
    error: string | null;
    /** 'stdio' for a local command, otherwise an HTTP transport with a url. */
    transport: string;
    url: string | null;
    command: string | null;
    category: string | null;
    toolCount: number;
    tools: McpTool[];
    updatedAt: string | null;
}

/**
 * GET /api/mcp-server/token.
 *
 * `exists` distinguishes "a secret is stored" from "the user holds a working
 * token": revoking overwrites the stored half with a value nobody has and sets
 * a revoke marker, so the presence of a secret proves nothing on its own.
 */
export interface McpTokenStatus {
    exists: boolean;
    /** Absolute when PUBLIC_BASE_URL is set on the server, else the bare '/mcp'. */
    url: string;
    transport: string;
}

/** POST /api/mcp-server/token. `token` is returned once and never again. */
export interface McpMintedToken {
    token: string;
    url: string;
    transport: string;
    note?: string;
}
