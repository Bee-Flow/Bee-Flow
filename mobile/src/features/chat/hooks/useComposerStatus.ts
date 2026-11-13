/**
 * The composer's two server reads: the Privacy Shield's status (its claim)
 * and the flags that gate the media generators. Both are advisory — a
 * failure says nothing rather than something wrong — so neither retries.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchComposerFlags, fetchShieldStatus } from '../api/composerStatus';
import { composerKeys } from '../api/keys';
import { imageModelOptions, mediaGatesFor, type MediaKind, type MediaOption } from '../model/mediaCatalog';
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

function useComposerFlags() {
    return useQuery({
        queryKey: composerKeys.flags,
        queryFn: ({ signal }) => fetchComposerFlags(signal),
        staleTime: 5 * 60_000,
        retry: false,
    }).data;
}

/** Which generators this person may use here: the org allows it and what it needs is configured. */
export function useMediaGates(): Readonly<Record<MediaKind, boolean>> {
    const flags = useComposerFlags();
    return useMemo(() => mediaGatesFor(flags), [flags]);
}

/** The image models to offer: the server's list (Google and Azure), or Google's two from an older server. */
export function useImageModelOptions(): readonly MediaOption[] {
    const flags = useComposerFlags();
    return useMemo(() => imageModelOptions(flags?.imageModels), [flags]);
}
