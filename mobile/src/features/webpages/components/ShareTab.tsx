/**
 * Share: who can see the page, in the order of how far it reaches.
 *
 * Three audiences, never merged, because merging them is how a page meant for
 * five colleagues ends up on the open internet: PUBLISH puts the page in front
 * of signed-in colleagues; the PUBLIC ADDRESS is the page's own /w/<slug>;
 * an EXTERNAL LINK publishes a sanitized snapshot to whoever holds that one
 * address. Reach counts the links' views.
 *
 * An org viewer sees the publish state and the links; the public address is
 * owner-only on the server and is left out for them.
 */

import React, { useMemo, useState } from 'react';

import { CreatedLinkSheet } from './CreatedLinkSheet';
import { NewLinkSheet } from './NewLinkSheet';
import { PublicSection } from './PublicSection';
import { PublishSection } from './PublishSection';
import { ReachSection } from './ReachSection';
import { RevokeLinkSheet } from './RevokeLinkSheet';
import { SharesSection } from './SharesSection';
import { TabScroll } from './TabScroll';
import { useWebpage, useWebpageShares } from '../hooks/queries';
import { reachOf } from '../model/format';
import type { WebpageDetail, WebpageShare } from '../model/types';

export function ShareTab({ pageId, detail }: { pageId: string; detail: WebpageDetail }) {
    const [newLinkOpen, setNewLinkOpen] = useState(false);
    const [revoking, setRevoking] = useState<WebpageShare | null>(null);
    const [createdUrl, setCreatedUrl] = useState<string | null>(null);
    const page = useWebpage(pageId);
    const shares = useWebpageShares(pageId);
    const reach = useMemo(() => reachOf(shares.data ?? []), [shares.data]);
    const { webpage, readOnly } = detail;

    return (
        <TabScroll
            onRefresh={() => Promise.all([page.refetch(), shares.refetch()])}
        >
            <PublishSection pageId={pageId} webpage={webpage} owned={!readOnly} />
            {readOnly ? null : <PublicSection pageId={pageId} />}
            <ReachSection reach={reach} />
            <SharesSection
                pageId={pageId}
                shares={shares}
                owned={!readOnly}
                onNewLink={() => setNewLinkOpen(true)}
                onRevoke={setRevoking}
            />

            <NewLinkSheet
                visible={newLinkOpen}
                pageId={pageId}
                pageName={webpage.name}
                onClose={() => setNewLinkOpen(false)}
                onCreated={(url) => {
                    setNewLinkOpen(false);
                    if (url) setCreatedUrl(url);
                }}
            />
            <CreatedLinkSheet url={createdUrl} pageName={webpage.name} onClose={() => setCreatedUrl(null)} />
            <RevokeLinkSheet pageId={pageId} share={revoking} onDone={() => setRevoking(null)} />
        </TabScroll>
    );
}
