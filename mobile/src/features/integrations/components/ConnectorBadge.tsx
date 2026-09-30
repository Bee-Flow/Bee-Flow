/** A connector's state in one badge, or none when it is simply not connected. */

import React from 'react';

import { Badge } from '@/shared/ui';

export function ConnectorBadge({
    needsReauth,
    connected,
    notConfigured,
}: {
    needsReauth: boolean;
    connected: boolean;
    notConfigured: boolean;
}) {
    if (needsReauth) return <Badge label="Needs re-authorising" tone="warning" />;
    if (connected) return <Badge label="Connected" tone="success" />;
    if (notConfigured) return <Badge label="Not set up" tone="neutral" />;
    return null;
}
