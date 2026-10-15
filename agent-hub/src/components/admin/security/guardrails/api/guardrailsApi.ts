import { API_BASE, authFetch } from '../../../../../utils/helpers';

/**
 * Data access for the Guardrail Configs console.
 *
 * Everything the console fetches goes through here, so the day this surface
 * moves to react-query it is one file, not thirty call sites.
 */

export interface ApiError extends Error {
    status?: number;
    body?: unknown;
}

import type { RegexRule as GuardrailRule, RuleCollection as GuardrailCollection } from '../patterns/patternTypes';

export type { GuardrailRule, GuardrailCollection };

export interface DirectChatGuardrails {
    enabled?: boolean;
    collectionIds?: string[];
}

export interface AiConfig {
    regexGuardrails?: {
        rules?: GuardrailRule[];
        collections?: GuardrailCollection[];
    };
    directChatRegexGuardrails?: DirectChatGuardrails;
    [key: string]: unknown;
}

export interface Organisation {
    id: string;
    [key: string]: unknown;
}

export interface OrgShield {
    enabled?: boolean;
    collectionIds?: string[];
    [key: string]: unknown;
}

export interface GuardStatus {
    configured?: boolean;
    reachable?: boolean;
    [key: string]: unknown;
}

export async function apiJson<T = Record<string, unknown> | null>(path: string, options?: RequestInit): Promise<T> {
    const res = await authFetch(`${API_BASE}${path}`, options);
    let body: unknown = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
        const message = (body as { error?: string } | null)?.error;
        const err: ApiError = new Error(message || `Request failed (${res.status})`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body as T;
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
const PROBES: Record<string, string> = {
    presets: '/api/admin/guardrail-presets',
    termLibraries: '/api/admin/guardrail-term-libraries',
    piiProfiles: '/api/admin/guardrail-pii-profiles',
    dlpPolicies: '/api/admin/guardrail-dlp-policies',
};

let _capabilityCache: Record<string, boolean> | null = null;

export async function probeCapabilities({ force = false }: { force?: boolean } = {}): Promise<Record<string, boolean>> {
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
export function __setCapabilities(caps: Record<string, boolean> | null) { _capabilityCache = caps; }

// ── Things that exist today ───────────────────────────────────────────────

/** The server-wide `ai` blob: regex rules, collections, direct-chat binding. */
export function fetchAiConfig() {
    return apiJson<AiConfig>('/ai/config');
}

export function saveRegexGuardrails({ rules, collections }: { rules: GuardrailRule[]; collections: GuardrailCollection[] }) {
    return apiJson('/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regexGuardrails: { rules, collections } }),
    });
}

export function saveDirectChatGuardrails({ enabled, collectionIds }: { enabled: boolean; collectionIds: string[] }) {
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
    return apiJson<Organisation[]>('/auth/organizations');
}

export function fetchOrgShield(orgId: string) {
    return apiJson<OrgShield>(`/api/org-privacy-shield/${orgId}`);
}

/**
 * Is the PII Guard sidecar installed and reachable?
 * Without it every PII control on this page is decoration.
 */
export function fetchGuardStatus() {
    return apiJson<GuardStatus>('/api/org-privacy-shield/user/guard-status');
}

export interface GenerateRegexResponse {
    success?: boolean;
    message?: string;
    error?: string;
    regexGuardrails?: {
        rules?: GuardrailRule[];
        collections?: GuardrailCollection[];
    };
}

export function generateRegexWithAi({ prompt, modelTier }: { prompt: string; modelTier?: string }) {
    return apiJson<GenerateRegexResponse | null>('/ai/generate-regex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, modelTier }),
    });
}
