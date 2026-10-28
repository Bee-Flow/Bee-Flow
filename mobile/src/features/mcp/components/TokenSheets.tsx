/**
 * The token's confirmations and its show-once sheet. Replacing and revoking
 * both cut off every client still holding the current value, so both ask.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ConfirmSheet } from '@/shared/ui';

import { SecretOnce } from './SecretOnce';
import type { TokenFlow } from '../hooks/useTokenFlow';

export function TokenSheets({ flow }: { flow: TokenFlow }) {
    const t = useTranslation();
    return (
        <>
            <ConfirmSheet
                visible={flow.confirmMint}
                title={t('mobile.mcp.replace_title', 'Replace your token?')}
                message={t('mobile.mcp.replace_message', 'Minting a new token revokes the one you have now. Any client still configured with the old value stops working the moment this finishes.')}
                confirmLabel={t('mobile.mcp.replace_token', 'Replace token')}
                busy={flow.mint.isPending}
                onConfirm={() => flow.mint.mutate()}
                onCancel={() => flow.setConfirmMint(false)}
            />
            <ConfirmSheet
                visible={flow.confirmRevoke}
                title={t('mobile.mcp.revoke_title', 'Revoke your token?')}
                message={t('mobile.mcp.revoke_message', 'Every client using it stops reaching Bee Flow straight away. You can mint a new one afterwards, but the old value can never be brought back.')}
                confirmLabel={t('mobile.mcp.revoke_token', 'Revoke token')}
                busy={flow.revoke.isPending}
                onConfirm={() => flow.revoke.mutate()}
                onCancel={() => flow.setConfirmRevoke(false)}
            />
            <SecretOnce
                visible={flow.minted !== null}
                secret={flow.minted}
                title={t('mobile.mcp.minted_title', 'Your MCP token')}
                description={t('mobile.mcp.minted_description', 'Paste it into your client as the Authorization bearer value. Only half of it is stored on the server, so this is the only time it can be shown.')}
                shareTitle={t('mobile.mcp.minted_share', 'Bee Flow MCP token')}
                onDone={flow.clearMinted}
            />
        </>
    );
}
