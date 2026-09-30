/**
 * Who can see a page and what it is wired to: routes/webpagesAudience.js
 * (the public address) and routes/webpagesGrants.js (bridge grants, the data
 * cards and the calls the page makes itself). All owner-only.
 *
 * The internal audience — signed-in colleagues — is not here: it stays on
 * PATCH /:id/publish (endpoints.ts setWebpagePublished), which is the one way
 * to those columns.
 */

import { api } from '@/core/api/client';

import { readAudience, readDataCards, readGrants, readPageCalls } from './audienceReaders';
import { pagePath } from './endpoints';
import type { DataCards, PageCalls, PublicChoice, WebpageAudience, WebpageGrants } from '../model/audienceTypes';

const grantsPath = (id: string) => `${pagePath(id)}/grants`;

export async function getAudience(id: string, signal?: AbortSignal): Promise<WebpageAudience> {
    return readAudience(await api.get<unknown>(`${pagePath(id)}/audience`, { signal }));
}

/**
 * Public on or off. Turning it ON must say which columns of every bound table
 * may be shown — a table missing from `publicColumns` goes to none — and the
 * server keeps the existing link unless the access settings changed.
 * Switching OFF sends only `on`: the column choice is not asked for then.
 */
export async function setPublic(id: string, choice: PublicChoice): Promise<WebpageAudience> {
    const body = choice.on
        ? {
              on: true,
              publicColumns: choice.publicColumns,
              accessMode: choice.accessMode,
              ...(choice.accessMode === 'password' && choice.password ? { password: choice.password } : {}),
              ...(choice.accessMode === 'email' ? { allowedEmails: choice.allowedEmails ?? [] } : {}),
              ...(choice.expiresAt !== undefined ? { expiresAt: choice.expiresAt } : {}),
          }
        : { on: false };
    return readAudience(await api.put<unknown>(`${pagePath(id)}/audience/public`, body));
}

export async function getGrants(id: string, signal?: AbortSignal): Promise<WebpageGrants> {
    return readGrants(await api.get<unknown>(grantsPath(id), { signal }));
}

/** Let the page run one of your automations (as you, from the page's bridge). */
export async function grantAutomation(id: string, automationId: string, label?: string): Promise<void> {
    await api.post(`${grantsPath(id)}/automations`, { automationId, ...(label ? { label } : {}) });
}

export async function revokeGrant(id: string, kind: 'integrations' | 'automations', key: string): Promise<void> {
    await api.delete(`${grantsPath(id)}/${kind}/${encodeURIComponent(key)}`);
}

export async function getDataCards(id: string, signal?: AbortSignal): Promise<DataCards> {
    return readDataCards(await api.get<unknown>(`${pagePath(id)}/data-cards`, { signal }));
}

export async function getPageCalls(id: string, signal?: AbortSignal): Promise<PageCalls> {
    return readPageCalls(await api.get<unknown>(`${pagePath(id)}/bindings`, { signal }));
}
