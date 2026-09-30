/**
 * Webpage endpoints for the page itself, under /api/webpages
 * (server/routes/webpages/crud.js, lifecycle.js, publishing.js,
 * publicShares.js, draftDocument.js, and routes/webpageExport.js).
 * Sources, versions and chat are in buildEndpoints.ts; who can see the page
 * and what it is wired to in audienceEndpoints.ts.
 *
 * The mount is gated by requireModule('webpages') + requireCapability
 * ('webpages') — a compound beta: the licence AND the beta flag — so a 402/403
 * is a normal answer the screen renders next to the thing it gates.
 */

import { api } from '@/core/api/client';
import { guardedDelete } from '@/core/api/deleteGuard';
import { shareServerFile } from '@/core/api/shareFile';

import { readDraftDocument, readFiles } from './buildReaders';
import {
    readCreatedShare,
    readCreatedWebpage,
    readPublished,
    readWebpageDetail,
    readWebpages,
    readWebpageShares,
} from './readers';
import type { DraftDocument, WebpageFiles } from '../model/buildTypes';
import type { CreatedWebpageShare, Webpage, WebpageDetail, WebpageFramework, WebpageShare } from '../model/types';

export const pagePath = (id: string) => `/api/webpages/${encodeURIComponent(id)}`;
const sharesPath = (id: string) => `${pagePath(id)}/public-shares`;

/** What PUT /:id may change from the phone. The schema is strict: nothing else is sent. */
export interface WebpagePatch {
    name?: string;
    description?: string;
    instructions?: string;
    knowledgeBaseIds?: string[];
}

export async function listWebpages(signal?: AbortSignal): Promise<Webpage[]> {
    return readWebpages(await api.get<unknown>('/api/webpages', { signal }));
}

/**
 * One page's metadata. The response also carries the three file bodies, and
 * keeping a multi-megabyte bundle of HTML in a phone's memory to render a
 * name and a publish switch would be the most expensive thing on the screen —
 * so the reader keeps the row and drops the rest.
 */
export async function getWebpage(id: string, signal?: AbortSignal): Promise<WebpageDetail | null> {
    return readWebpageDetail(await api.get<unknown>(pagePath(id), { signal }));
}

/**
 * The three file bodies. There is no bodies-only route, so this is the same
 * GET /:id read for its `files` — asked for only when the builder chat needs
 * to send the current page with a turn.
 */
export async function getWebpageFiles(id: string, signal?: AbortSignal): Promise<WebpageFiles> {
    return readFiles(await api.get<unknown>(pagePath(id), { signal }));
}

/**
 * The page as one ready-to-run document, built by the server for every
 * framework (React is bundled there): what the web editor's preview shows,
 * with the live bridges and a preview token baked in. An org reader gets the
 * published snapshot, as GET /:id gives them.
 */
export async function getDraftDocument(id: string, signal?: AbortSignal): Promise<DraftDocument> {
    return readDraftDocument(await api.get<unknown>(`${pagePath(id)}/draft-document`, { signal }));
}

/**
 * A new page. `prompt` is the brief the builder reads (the server derives a
 * name from it when none is given). `framework` is sent only when given;
 * otherwise the server's default applies, as when the web creates a page.
 */
export async function createWebpage(input: {
    name?: string;
    prompt?: string;
    framework?: WebpageFramework;
}): Promise<Webpage | null> {
    const body = {
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
        ...(input.framework ? { framework: input.framework } : {}),
    };
    return readCreatedWebpage(await api.post<unknown>('/api/webpages', body));
}

/** Save metadata. Owner-only; the server answers 404 to anybody else. */
export async function updateWebpage(id: string, patch: WebpagePatch): Promise<void> {
    await api.put(pagePath(id), patch);
}

/** A copy on your own account. Anyone who can read a page may clone it. */
export async function cloneWebpage(id: string, name?: string): Promise<Webpage | null> {
    return readCreatedWebpage(await api.post<unknown>(`${pagePath(id)}/clone`, name ? { name } : {}));
}

/**
 * Render the saved page to a PDF on the server and hand it to the share
 * sheet. The server refuses a React + Material UI page with a 400 that says
 * why; the caller shows that sentence.
 */
export async function exportWebpagePdf(id: string, name: string): Promise<void> {
    await shareServerFile(`${pagePath(id)}/export/pdf`, `${name || 'webpage'}.pdf`, 'application/pdf', {
        method: 'POST',
    });
}

/**
 * Publish to, or withdraw from, the organisation.
 *
 * This is the INTERNAL audience — signed-in colleagues, through the same
 * sandboxed preview the author uses — not the anonymous `/share/:token` link.
 * `sharedGroups` is omitted rather than sent empty: the server treats
 * undefined as "leave as-is" and an empty array as "the whole organisation".
 *
 * Colleagues read a snapshot pinned at the first publish, not the live page.
 * `republish` pins what is there now (publishing.js, the web header's
 * Republish); a plain publish of a page that is already live keeps the pin.
 */
export async function setWebpagePublished(id: string, isPublished: boolean, republish = false): Promise<boolean> {
    const body = republish ? { isPublished: true, republish: true } : { isPublished };
    return readPublished(await api.patch<unknown>(`${pagePath(id)}/publish`, body), republish || isPublished);
}

/**
 * Delete a page — the SECOND half of a two-step the server insists on.
 *
 * `DELETE /api/webpages/:id` refuses with 409 unless the request says
 * `confirm=1`, and it refuses on the FIRST press for every page: two of the
 * kinds it scans (`chat`, `agent`) are structurally unanswerable, so the
 * refusal always carries an `unchecked` list. Sending the flag always would
 * skip the check; never sending it makes the page undeletable from Android.
 * Pass it only after the person has been shown the guard's answer.
 */
export async function deleteWebpage(id: string, opts: { confirmedBreaking?: boolean } = {}): Promise<void> {
    await guardedDelete(pagePath(id), 'webpage', opts.confirmedBreaking);
}

export async function listWebpageShares(id: string, signal?: AbortSignal): Promise<WebpageShare[]> {
    return readWebpageShares(await api.get<unknown>(sharesPath(id), { signal }));
}

/**
 * Mint an external link. The response is the ONLY time the URL is guaranteed
 * to come back — the server stores a hash plus a best-effort encrypted copy.
 *
 * A password is optional and, if given, must be at least six characters or the
 * store throws before anything is written. Recipient allow-lists are left to
 * the desktop.
 */
export async function createWebpageShare(
    id: string,
    options: { title?: string; password?: string } = {},
): Promise<CreatedWebpageShare | null> {
    const password = options.password?.trim();
    const res = await api.post<unknown>(sharesPath(id), {
        accessMode: password ? 'password' : 'unlisted',
        ...(password ? { password } : {}),
        ...(options.title ? { title: options.title } : {}),
    });
    return readCreatedShare(res);
}

/**
 * Re-take the snapshot behind an existing link. A share serves a sanitized
 * copy taken at creation time; the token is unchanged, which is the point:
 * nobody has to be sent a new address.
 */
export async function refreshWebpageShare(id: string, shareId: string): Promise<void> {
    await api.post(`${sharesPath(id)}/${encodeURIComponent(shareId)}/refresh`);
}

/** Revoke a link. The token stops working immediately; the snapshot is purged. */
export async function revokeWebpageShare(id: string, shareId: string): Promise<void> {
    await api.delete(`${sharesPath(id)}/${encodeURIComponent(shareId)}`);
}
