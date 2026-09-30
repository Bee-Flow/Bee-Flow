/**
 * One result. No href means this app has no screen for the thing: the row
 * still shows — knowing it exists is most of the value — but it is not a
 * button, because a tap that does nothing is worse than no tap at all.
 */

import React from 'react';

import { Badge, ListRow } from '@/shared/ui';

import type { SearchHit } from '../model/types';

export function HitRow({ hit, onPress }: { hit: SearchHit; onPress: (hit: SearchHit) => void }) {
    return (
        <ListRow
            title={hit.title}
            subtitle={hit.subtitle || undefined}
            meta={hit.meta}
            wrapTitle
            onPress={hit.href ? () => onPress(hit) : undefined}
            trailing={hit.href ? undefined : <Badge label="Web only" tone="neutral" />}
        />
    );
}
