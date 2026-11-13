/**
 * What the composer may offer and say, read from two server answers:
 *
 *   /api/privacy/shield-status — whether the Privacy Shield is on for this
 *   person and whether its detector is reachable now (the pill's claim);
 *   /ai/user-settings — which generators the org allows and whether this
 *   person has the keys they need (the media panel's gates).
 *
 * The user-settings response is also read by features/integrations for its
 * own fields; this reader takes only the composer's slice of it, under its
 * own cache key, so neither reader's shape leaks into the other's cache.
 */

import { api } from '@/core/api/client';
import { field, nullable, shapeOf } from '@/core/api/contract';

export interface ShieldStatus {
    enabled: boolean;
    source: string | null;
    /** 'redact' | 'block' | 'ask' | … */
    action: string | null;
    failMode: string | null;
    guardReachable: boolean;
    euMode: boolean;
    coworkEnabled: boolean;
}

/** An image model the server can generate with (Google, or an Azure deployment as `azure/<deployment>`). */
export interface ImageModelChoice {
    id: string;
    label: string;
}

export interface ComposerFlags {
    /** null: the org places no restriction. */
    orgEnabledIntegrations: string[] | null;
    hasGoogleKey: boolean;
    hasElevenLabsKey: boolean;
    /** Whether any image model is configured; absent from a server older than Azure images. */
    hasImageGen?: boolean;
    /** The image models this person can pick; null from a server older than Azure images. */
    imageModels: ImageModelChoice[] | null;
    /** 'disabled' switches web search off for everyone. */
    searchProvider: string | null;
}

const readImageModel = shapeOf({ id: field.str(''), label: field.str('') });

/** The server's image models, rows without an id dropped; null when the server sends no list. */
function readImageModels(value: unknown): ImageModelChoice[] | null {
    if (!Array.isArray(value)) return null;
    return value.map(readImageModel).filter((m) => m.id !== '');
}

export const readShieldStatus: (raw: unknown) => ShieldStatus | null = nullable(
    shapeOf({
        enabled: field.bool(false),
        source: field.strOrNull,
        action: field.strOrNull,
        failMode: field.strOrNull,
        guardReachable: field.bool(false),
        euMode: field.bool(false),
        coworkEnabled: field.bool(false),
    }),
);

export const readComposerFlags: (raw: unknown) => ComposerFlags | null = nullable(
    shapeOf({
        orgEnabledIntegrations: field.strArrayOrNull,
        hasGoogleKey: field.bool(false),
        hasElevenLabsKey: field.bool(false),
        hasImageGen: field.optBool,
        imageModels: readImageModels,
        searchProvider: field.strOrNull,
    }),
);

export async function fetchShieldStatus(signal?: AbortSignal): Promise<ShieldStatus | null> {
    return readShieldStatus(await api.get<unknown>('/api/privacy/shield-status', { signal }));
}

export async function fetchComposerFlags(signal?: AbortSignal): Promise<ComposerFlags | null> {
    return readComposerFlags(await api.get<unknown>('/ai/user-settings', { signal }));
}
