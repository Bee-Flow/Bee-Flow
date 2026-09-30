/**
 * The token's confirmations and its show-once sheet. Replacing and revoking
 * both cut off every client still holding the current value, so both ask.
 */

import React from 'react';

import { ConfirmSheet } from '@/shared/ui';

import { SecretOnce } from './SecretOnce';
import type { TokenFlow } from '../hooks/useTokenFlow';

export function TokenSheets({ flow }: { flow: TokenFlow }) {
    return (
        <>
            <ConfirmSheet
                visible={flow.confirmMint}
                title="Replace your token?"
                message="Minting a new token revokes the one you have now. Any client still configured with the old value stops working the moment this finishes."
                confirmLabel="Replace token"
                busy={flow.mint.isPending}
                onConfirm={() => flow.mint.mutate()}
                onCancel={() => flow.setConfirmMint(false)}
            />
            <ConfirmSheet
                visible={flow.confirmRevoke}
                title="Revoke your token?"
                message="Every client using it stops reaching Bee Flow straight away. You can mint a new one afterwards, but the old value can never be brought back."
                confirmLabel="Revoke token"
                busy={flow.revoke.isPending}
                onConfirm={() => flow.revoke.mutate()}
                onCancel={() => flow.setConfirmRevoke(false)}
            />
            <SecretOnce
                visible={flow.minted !== null}
                secret={flow.minted}
                title="Your MCP token"
                description="Paste it into your client as the Authorization bearer value. Only half of it is stored on the server, so this is the only time it can be shown."
                shareTitle="Bee Flow MCP token"
                onDone={flow.clearMinted}
            />
        </>
    );
}
