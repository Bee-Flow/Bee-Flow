/**
 * Every endpoint the Webpages, Forms and MCP screens talk to.
 *
 * Paths are the FULL client-visible ones. The routers read as if mounted at
 * the root, and several of their own comments name the wrong prefix, so these
 * come from the `app.use(...)` lines in server/index.js and nowhere else:
 *
 *   /api/webpages     → routes/webpages.js (+ webpagesGrants, webpageExport)
 *   /api/automation   → routes/automation.js (+ routes/automation/*)
 *   /ai               → routes/ai.js  — NOT /api/ai. `/ai/mcp-servers` is the
 *                       MCP *client* registry, in routes/ai/config/integrations.js
 *   /api/mcp-server   → routes/mcpServerTokens.js — the token for Bee Flow's
 *                       own MCP *server*. Different surface, adjacent name.
 *
 * Three of these are gated at or near the mount, so a 402/403 is a normal
 * answer that each screen renders next to the thing it gates rather than as a
 * screen-wide failure:
 *   webpages     → requireModule('webpages') + requireCapability('webpages')
 *                  (a compound beta: the licence AND the beta flag)
 *   automations  → requireModule('automation') + requireLicenseFeature('automations')
 *   mcp-servers  → requireFeature('mcp_marketplace'), an Enterprise feature
 */

import type {
    CreatedWebpageShare,
    FormSubmission,
    FormSummary,
    McpMintedToken,
    McpServer,
    McpTokenStatus,
    Webpage,
    WebpageDetail,
    WebpageShare,
} from './types';
import { api } from '../../api/client';
import { apiUrl } from '../../api/server';

export const publishingKeys = {
    webpages: ['publishing', 'webpages'] as const,
    webpage: (id: string) => ['publishing', 'webpage', id] as const,
    webpageShares: (id: string) => ['publishing', 'webpage', id, 'shares'] as const,
    forms: ['publishing', 'forms'] as const,
    formSubmissions: (automationId: string) =>
        ['publishing', 'form-submissions', automationId] as const,
    mcpServers: ['publishing', 'mcp', 'servers'] as const,
    mcpToken: ['publishing', 'mcp', 'token'] as const,
};

/**
 * Make a server-relative public path absolute against the configured server.
 *
 * The form list hands back `/f/<token>` with no origin, and the MCP token
 * endpoint degrades to a bare `/mcp` when PUBLIC_BASE_URL is unset. Both are
 * only useful to a person if they can paste them somewhere, and the origin
 * this device reaches the server on is the one origin we know actually works.
 */
export function absoluteUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return apiUrl(pathOrUrl);
}

// ── Webpages ────────────────────────────────────────────────────────

export async function listWebpages(signal?: AbortSignal): Promise<Webpage[]> {
    const res = await api.get<{ webpages: Webpage[] }>('/api/webpages', { signal });
    return res?.webpages ?? [];
}

/**
 * One page's metadata.
 *
 * The response also carries `sources`, `files`, `chatMessages` and
 * `extraFiles` — the whole project, because the desktop IDE opens from this
 * one call. None of it is read here: this app does not edit pages, and pulling
 * a multi-megabyte bundle of HTML into a phone's memory to render a name and a
 * publish switch would be the most expensive thing on the screen.
 */
export async function getWebpage(id: string, signal?: AbortSignal): Promise<WebpageDetail | null> {
    const res = await api.get<{ webpage: Webpage; readOnly?: boolean }>(
        `/api/webpages/${encodeURIComponent(id)}`,
        { signal },
    );
    if (!res?.webpage) return null;
    return { webpage: res.webpage, readOnly: res.readOnly === true };
}

/**
 * Publish to, or withdraw from, the organisation.
 *
 * This is the INTERNAL audience — signed-in colleagues, viewing through the
 * same sandboxed preview the author uses. It is not the `/share/:token` link
 * below, which is the anonymous one. Confusing the two is how a page meant for
 * the team ends up on the open internet, so the screen names both.
 *
 * `sharedGroups` is omitted rather than sent empty when the caller does not
 * mean to change it: the server treats undefined as "leave as-is" and an empty
 * array as "the whole organisation" (routes/webpages.js PATCH /:id/publish).
 */
export async function setWebpagePublished(
    id: string,
    isPublished: boolean,
): Promise<boolean> {
    const res = await api.patch<{ success: boolean; isPublished: boolean }>(
        `/api/webpages/${encodeURIComponent(id)}/publish`,
        { isPublished },
    );
    return res?.isPublished ?? isPublished;
}

/**
 * Delete a page — the SECOND half of a two-step the server insists on.
 *
 * `DELETE /api/webpages/:id` refuses with 409 unless the request says
 * `confirm=1`, and it refuses on the FIRST press for every page: two of the
 * kinds it scans (`chat`, `agent`) are structurally unanswerable, so `complete`
 * is never true and the refusal always carries at least an `unchecked` list.
 * That refusal is the payload the screen shows before it asks again.
 *
 * So this flag is not a convenience. Sending it always would skip the check
 * outright — the server takes it as "this person has seen what is at stake" —
 * and never sending it makes the page undeletable from Android. Pass it only
 * after the person has been shown the guard's answer.
 */
export async function deleteWebpage(
    id: string,
    opts: { confirmedBreaking?: boolean } = {},
): Promise<void> {
    const suffix = opts.confirmedBreaking ? '?confirm=1' : '';
    await api.delete(`/api/webpages/${encodeURIComponent(id)}${suffix}`);
}

export async function listWebpageShares(
    id: string,
    signal?: AbortSignal,
): Promise<WebpageShare[]> {
    const res = await api.get<{ shares: WebpageShare[] }>(
        `/api/webpages/${encodeURIComponent(id)}/public-shares`,
        { signal },
    );
    return res?.shares ?? [];
}

/**
 * Mint an external link. The response is the ONLY time the URL is guaranteed
 * to come back — the server stores a hash plus an encrypted copy, and the
 * encrypted copy is best-effort (key rotation drops it, and rows created
 * before it existed never had one).
 *
 * A password is optional and, if given, must be at least six characters or the
 * store throws before anything is written. Recipient allow-lists exist too but
 * are left to the desktop: typing a list of colleagues' addresses on a phone
 * to guard a link is a worse experience than sending them the link.
 */
export async function createWebpageShare(
    id: string,
    options: { title?: string; password?: string } = {},
): Promise<CreatedWebpageShare | null> {
    const password = options.password?.trim();
    const res = await api.post<{ share: WebpageShare; url: string }>(
        `/api/webpages/${encodeURIComponent(id)}/public-shares`,
        {
            accessMode: password ? 'password' : 'unlisted',
            ...(password ? { password } : {}),
            ...(options.title ? { title: options.title } : {}),
        },
    );
    if (!res?.share || !res.url) return null;
    return { share: res.share, url: res.url };
}

/**
 * Re-take the snapshot behind an existing link.
 *
 * A share serves a sanitized copy of the page taken at creation time, not the
 * live page — so a link created last week still shows last week's content
 * until this runs. The token is unchanged, which is the point: nobody has to
 * be sent a new address.
 */
export async function refreshWebpageShare(id: string, shareId: string): Promise<void> {
    await api.post(
        `/api/webpages/${encodeURIComponent(id)}/public-shares/${encodeURIComponent(shareId)}/refresh`,
    );
}

/** Revoke a link. The token stops working immediately; the snapshot is purged. */
export async function revokeWebpageShare(id: string, shareId: string): Promise<void> {
    await api.delete(
        `/api/webpages/${encodeURIComponent(id)}/public-shares/${encodeURIComponent(shareId)}`,
    );
}

// ── Forms ───────────────────────────────────────────────────────────

/**
 * Every hosted form in the caller's organisation.
 *
 * Org-scoped, not per-author, and deliberately so: a form has an address, and
 * an address belongs to the organisation that hands it out. `mine` marks the
 * ones whose routine this caller can also act on — everything below this line
 * is per-user, so a colleague's form is readable here and nowhere else.
 */
export async function listForms(signal?: AbortSignal): Promise<FormSummary[]> {
    const res = await api.get<{ forms: FormSummary[] }>('/api/automation/forms', { signal });
    return res?.forms ?? [];
}

/** The absolute address of a form. See absoluteUrl for why it is built here. */
export function publicFormUrl(form: Pick<FormSummary, 'id' | 'url'>): string {
    return absoluteUrl(form.url || `/f/${form.id}`);
}

/**
 * The submissions behind a form.
 *
 * A submission IS a run — routes/automation/formPublic.js starts one with
 * `triggerKind: 'form'` and the answers as its trigger payload — so this is
 * the run list filtered to that trigger. There is no submissions table to read
 * instead, and no endpoint keyed by form page id: a routine with two form
 * triggers pours both into one run history, which is why the screen says
 * "submissions to this routine" rather than claiming a per-link count.
 *
 * Owner-only (`a.userId !== userId` → 403), hence the `mine` guard at the call
 * site rather than a retry here.
 */
export async function listFormSubmissions(
    automationId: string,
    signal?: AbortSignal,
): Promise<FormSubmission[]> {
    const res = await api.get<{ runs: FormSubmission[] }>(
        `/api/automation/${encodeURIComponent(automationId)}/runs`,
        { signal, query: { triggerKind: 'form', limit: 50 } },
    );
    return res?.runs ?? [];
}

/**
 * Open or close a form.
 *
 * There is no per-form switch on the server: a form is reachable only while
 * its routine is active and not a draft, so this arms or disarms the WHOLE
 * routine — every other trigger on it included. The screen says that out loud
 * before the tap, because a scheduled trigger silently stopping is not
 * something to discover a week later.
 *
 * Activation re-validates the flow at `stage: 'strict'` and checks every tool
 * against the caller's permitted apps, so a 400 here is a real "this cannot go
 * live" and its message is worth showing verbatim.
 */
export async function setFormOpen(automationId: string, open: boolean): Promise<void> {
    await api.post(
        `/api/automation/${encodeURIComponent(automationId)}/${open ? 'activate' : 'deactivate'}`,
    );
}

// ── MCP ─────────────────────────────────────────────────────────────

/** The raw row shape `GET /ai/mcp-servers` returns (mcpStore.parseRow → `...row`). */
interface McpServerRow {
    id: string;
    name: string;
    description?: string | null;
    icon?: string | null;
    enabled?: boolean;
    status?: string | null;
    error?: string | null;
    transport?: string | null;
    url?: string | null;
    command?: string | null;
    category?: string | null;
    tools_cache?: { name: string; description?: string }[] | null;
    updated_at?: string | null;
}

function toMcpServer(row: McpServerRow): McpServer {
    const tools = row.tools_cache ?? [];
    return {
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        icon: row.icon ?? '',
        enabled: row.enabled !== false,
        status: row.status ?? 'disconnected',
        error: row.error ?? null,
        transport: row.transport ?? 'stdio',
        url: row.url ?? null,
        command: row.command ?? null,
        category: row.category ?? null,
        toolCount: tools.length,
        tools,
        updatedAt: row.updated_at ?? null,
    };
}

/**
 * The MCP servers this Bee Flow talks OUT to.
 *
 * The rows come straight off the table in snake_case — mcpStore.parseRow
 * spreads the row and only re-parses the JSON columns — so the mapping happens
 * here rather than leaking `tools_cache` into a screen.
 */
export async function listMcpServers(signal?: AbortSignal): Promise<McpServer[]> {
    const res = await api.get<{ servers: McpServerRow[] }>('/ai/mcp-servers', { signal });
    return (res?.servers ?? []).map(toMcpServer);
}

/**
 * Re-probe a server and re-cache its tools.
 *
 * This actually connects — spawning a command or opening an HTTP session — so
 * it is slow and must never retry: a second probe of a server that is simply
 * down costs another timeout for the same answer.
 */
export async function refreshMcpServer(id: string): Promise<number> {
    const res = await api.post<{ success: boolean; tools?: unknown[] }>(
        `/ai/mcp-servers/${encodeURIComponent(id)}/refresh`,
        undefined,
        { timeoutMs: 60_000, retry: false },
    );
    return res?.tools?.length ?? 0;
}

/** Whether the caller holds a working token, and where to point a client. */
export async function getMcpTokenStatus(signal?: AbortSignal): Promise<McpTokenStatus> {
    const res = await api.get<McpTokenStatus>('/api/mcp-server/token', { signal });
    return {
        exists: res?.exists === true,
        url: res?.url ?? '/mcp',
        transport: res?.transport ?? 'streamable_http',
    };
}

/**
 * Mint — or rotate — the caller's token.
 *
 * There is deliberately no way to hold two, so this revokes the previous one
 * the instant it succeeds. The value comes back once: only its random half is
 * stored, and it is stored, not kept, so nobody can show it again. `retry:
 * false` for that reason — a retried POST would mint a second token and
 * silently invalidate the one the first attempt already returned.
 */
export async function mintMcpToken(): Promise<McpMintedToken | null> {
    return api.post<McpMintedToken>('/api/mcp-server/token', undefined, { retry: false });
}

export async function revokeMcpToken(): Promise<void> {
    await api.delete('/api/mcp-server/token', { retry: false });
}
