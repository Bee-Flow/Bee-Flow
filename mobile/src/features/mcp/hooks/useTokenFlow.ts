/**
 * The token's life on this screen: create or replace it (replacing asks
 * first, because it revokes the current one), revoke it, and hold a freshly
 * minted value for the one sheet that shows it.
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useToast } from '@/shared/ui';

import { useMintMcpToken, useRevokeMcpToken } from './mutations';

export function useTokenFlow() {
    const { toast } = useToast();
    const [minted, setMinted] = useState<string | null>(null);
    const [confirmMint, setConfirmMint] = useState(false);
    const [confirmRevoke, setConfirmRevoke] = useState(false);

    const mint = useMintMcpToken({
        onSuccess: (result) => {
            setConfirmMint(false);
            if (!result?.token) {
                toast('The server did not return a token', 'error');
                return;
            }
            // Straight into the un-skippable sheet. The value is held nowhere
            // else — not in the query cache, not in a ref.
            setMinted(result.token);
        },
        onError: (err) => {
            setConfirmMint(false);
            toast(describeError(err).message, 'error');
        },
    });

    const revoke = useRevokeMcpToken({
        onSuccess: () => {
            setConfirmRevoke(false);
            toast('Token revoked', 'success');
        },
        onError: (err) => {
            setConfirmRevoke(false);
            toast(describeError(err).message, 'error');
        },
    });

    return {
        minted,
        clearMinted: () => setMinted(null),
        mint,
        revoke,
        confirmMint,
        setConfirmMint,
        confirmRevoke,
        setConfirmRevoke,
    };
}

export type TokenFlow = ReturnType<typeof useTokenFlow>;
