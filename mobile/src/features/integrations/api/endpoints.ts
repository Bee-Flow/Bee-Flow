/**
 * Integration endpoints: the per-provider connect routers under
 * `/api/integrations/<provider>`, and `/ai/user-settings` — mounted at `/ai`,
 * NOT `/api` (routes/ai/config/userSettings.js).
 */

import { api } from '@/core/api/client';
import { optional } from '@/core/api/optional';

import {
    readAuthUrl,
    readGithubConnect,
    readIntegrationStatus,
    readUserSettings,
} from './readers';
import type { IntegrationStatus, UserSettings } from '../model/types';

/**
 * Each provider owns its own `/status` shape (see IntegrationStatus). The
 * paths differ too: Google is `/api/integrations/google`, Microsoft is
 * `/api/integrations/microsoft`, and neither matches the catalogue id.
 */
export async function getIntegrationStatus(
    provider: string,
    signal?: AbortSignal,
): Promise<IntegrationStatus | null> {
    return optional(async () =>
        readIntegrationStatus(
            await api.get<unknown>(`/api/integrations/${provider}/status`, { signal, retry: false }),
        ),
    );
}

/** The provider's OAuth authorisation URL, with the CSRF state and PKCE
 *  verifier already stashed in this session server-side. */
export async function getIntegrationAuthUrl(provider: string): Promise<string | null> {
    return readAuthUrl(
        await api.get<unknown>(`/api/integrations/${provider}/auth-url`, { retry: false }),
    );
}

export async function disconnectIntegration(provider: string): Promise<void> {
    await api.post(`/api/integrations/${provider}/disconnect`);
}

/**
 * GitHub is the one connector with no OAuth dance: it takes a personal access
 * token, validates it against api.github.com before storing it, and answers
 * 400 with a readable message when the token is rejected. That makes it the
 * only one that can be completed entirely inside the app.
 */
export async function connectGithub(token: string): Promise<{ username?: string } | null> {
    return readGithubConnect(await api.post<unknown>('/api/integrations/github/connect', { token }));
}

/**
 * `GET /ai/user-settings`: the app allow-list, the EU-mode preference, Simple
 * Mode and a per-provider "is a credential stored" map.
 */
export async function getUserSettings(signal?: AbortSignal): Promise<UserSettings | null> {
    return readUserSettings(await api.get<unknown>('/ai/user-settings', { signal }));
}

/** A partial update: only the keys present in the body are written, so
 *  sending `{ simpleMode }` cannot clobber the user's integration keys. */
export async function saveUserSettings(
    patch: Partial<{ enabledApps: string[]; simpleMode: boolean }>,
): Promise<void> {
    await api.post('/ai/user-settings', patch);
}
