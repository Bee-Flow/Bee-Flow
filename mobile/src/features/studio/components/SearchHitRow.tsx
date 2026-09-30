/** One Studio search hit: its kind's tile and name; opens the object where it lives. */

import React from 'react';

import { KindTile, ListRow } from '@/shared/ui';

import { useOpenTarget } from '../hooks/useOpenTarget';
import type { StudioHit } from '../model/api';
import { sectionTarget } from '../model/links';
import type { StudioSection } from '../model/types';

export function SearchHitRow({ hit, section }: { hit: StudioHit; section: StudioSection | null }) {
    const open = useOpenTarget();
    return (
        <ListRow
            title={hit.name || hit.id}
            leading={<KindTile kind={section?.kind ?? null} icon={section?.kind ? undefined : section?.icon} size={28} />}
            onPress={section ? () => open(sectionTarget(section, hit.id)) : undefined}
            testID={`studio-search-hit-${hit.id}`}
        />
    );
}
