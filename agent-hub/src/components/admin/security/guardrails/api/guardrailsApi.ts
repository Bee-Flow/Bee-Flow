import type { RegexRule, RuleCollection } from '../patterns/patternTypes';
import { API_BASE, authFetch } from '@/utils/helpers';
import type { AuthFetchOptions } from '@/utils/helpers.types';
import { logger } from '@/utils/logger';

/**
 * Data access for the Guardrail Configs console.
 *
 * Everything the console fetches goes through here, so the day this surface
 * moves to react-query it is one file, not thirty call sites.
 */

/** The direct-chat binding of the server-wide `ai` blob. */
export interface DirectChatBinding {
    enabled: boolean;
    collectionIds: string[];
}

/** Which artefact families the server serves, by probe name. */
export type GuardrailCapabilities = Record<string, boolean>;

/** The Error apiJson throws for a non-2xx answer: the HTTP status and the parsed body ride along. */
interface GuardrailRequestError extends Error {
    status?: number;
    body?: unknown;
}

export async function apiJson(path: string, options?: AuthFetchOptions) {
    const res = await authFetch(`${API_BASE}${path}`, options);
    let body = null;
    try { body = await res.json(); } catch (err) { logger.debug('empty or non-JSON body', err); }
    if (!res.ok) {
        const err: GuardrailRequestError = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

/**
 * Which artefact families does this server actually serve?
 *
 * The console is built for presets, term libraries, PII profiles and DLP
 * policies; those endpoints are being added incrementally. Probing lets the UI
 * ship first and light each section up as its route appears, instead of either
 * blocking the redesign on the whole backend or shipping tabs that 404.
 *
 * A probe is one cheap GET per family. Anything that is not a clean success is
 * read as "absent" — including 403, because a section the caller may not use is
 * indistinguishable, from here, from one that does not exist, and both should
 * hide the tab rather than render a permission error inside it.
 *
 * Cached for the session: these endpoints appear on deploy, not mid-visit.
 */
const PROBES = {
    presets: '/api/admin/guardrail-presets',
    termLibraries: '/api/admin/guardrail-term-libraries',
    piiProfiles: '/api/admin/guardrail-pii-profiles',
    dlpPolicies: '/api/admin/guardrail-dlp-policies',
};

let _capabilityCache: GuardrailCapabilities | null = null;

export async function probeCapabilities({ force = false }: { force?: boolean } = {}) {
    if (_capabilityCache && !force) return _capabilityCache;
    const entries = await Promise.all(
        Object.entries(PROBES).map(async ([name, path]): Promise<[string, boolean]> => {
            try {
                await apiJson(path);
                return [name, true];
            } catch {
                return [name, false];
            }
        }),
    );
    _capabilityCache = Object.fromEntries(entries);
    return _capabilityCache;
}

/** Test seam — lets a test start from a known probe result. */
function __setCapabilities(caps: GuardrailCapabilities | null) { _capabilityCache = caps; }

// ── Things that exist today ───────────────────────────────────────────────

/** The server-wide `ai` blob: regex rules, collections, direct-chat binding. */
export function fetchAiConfig() {
    return apiJson('/ai/config');
}

export function saveRegexGuardrails({ rules, collections }: { rules: RegexRule[]; collections: RuleCollection[] }) {
    return apiJson('/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regexGuardrails: { rules, collections } }),
    });
}

export function saveDirectChatGuardrails({ enabled, collectionIds }: DirectChatBinding) {
    return apiJson('/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            directChatRegexGuardrails: {
                enabled,
                collectionIds,
                // Not admin-tunable: the detector scans both directions and the
                // action is chosen under the PII section instead.
                scope: { userInput: true, agentOutput: true },
                action: 'delete',
            },
        }),
    });
}

export function fetchOrganisations() {
    return apiJson('/auth/organizations');
}

export function fetchOrgShield(orgId: string) {
    return apiJson(`/api/org-privacy-shield/${orgId}`);
}

/**
 * Is the PII Guard sidecar installed and reachable?
 * Without it every PII control on this page is decoration.
 */
export function fetchGuardStatus() {
    return apiJson('/api/org-privacy-shield/user/guard-status');
}

export function generateRegexWithAi({ prompt, modelTier }: { prompt: string; modelTier?: string }) {
    return apiJson('/ai/generate-regex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, modelTier }),
    });
}
