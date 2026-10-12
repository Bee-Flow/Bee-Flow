// "Who is looking at this" on a document row, notebook card, task card or the
// team chat header: the people the live feed saw with this item open.

import React from 'react';
import { useProjectMembersQuery } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import { useProjectLive, viewKey, type ViewTarget } from './ProjectLiveContext';
import { ViewerStack } from './workspaceUi';

/** The faces, named from the (cached) member list. Only mounted while somebody is looking. */
function Faces({ projectId, ids }: { projectId: string | null; ids: string[] }) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId);
    return (
        <ViewerStack ids={ids} people={members.data?.people ?? {}} label={(name) => t('project_home.presence.viewing', '{name} is viewing this', { name })} />
    );
}

export default function ItemViewers({ type, id }: ViewTarget) {
    const { viewing, projectId } = useProjectLive();
    const ids = viewing[viewKey(type, id)];
    return ids?.length ? <Faces projectId={projectId} ids={ids} /> : null;
}
