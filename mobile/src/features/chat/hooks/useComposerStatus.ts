/**
 * The composer's two server reads: the Privacy Shield's status (its claim)
 * and the flags that gate the media generators. Both are advisory — a
 * failure says nothing rather than something wrong — so neither retries.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchComposerFlags, fetchShieldStatus } from '../api/composerStatus';
import { composerKeys } from '../api/keys';
import { MEDIA_GATES, MEDIA_KINDS, type MediaKind } from '../model/mediaCatalog';
import { shieldLine, type ShieldWords } from '../model/shieldLine';

/** The server polls its detector; a minute is fresh enough for a claim. */
const SHIELD_STALE_MS = 60_000;

export function useShieldLine(): ShieldWords | null {
    const query = useQuery({
        queryKey: composerKeys.shield,
        queryFn: ({ signal }) => fetchShieldStatus(signal),
        staleTime: SHIELD_STALE_MS,
        retry: false,
    });
    return shieldLine(query.data);
}

/** Which generators this person may use here: the org allows it and the key it needs is set. */
export function useMediaGates(): Readonly<Record<MediaKind, boolean>> {
    const query = useQuery({
        queryKey: composerKeys.flags,
        queryFn: ({ signal }) => fetchComposerFlags(signal),
        staleTime: 5 * 60_000,
        retry: false,
    });
    const flags = query.data;
    return useMemo(() => {
        const out = {} as Record<MediaKind, boolean>;
        for (const kind of MEDIA_KINDS) {
            const gate = MEDIA_GATES[kind];
            const orgOn = !flags?.orgEnabledIntegrations || flags.orgEnabledIntegrations.includes(gate.integration);
            const keyed = gate.key === 'google' ? Boolean(flags?.hasGoogleKey) : Boolean(flags?.hasElevenLabsKey);
            out[kind] = Boolean(flags) && orgOn && keyed;
        }
        return out;
    }, [flags]);
}
