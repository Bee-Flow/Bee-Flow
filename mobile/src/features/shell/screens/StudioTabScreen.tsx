/**
 * The Studio tab: features/studio's hub with the Workspace group (Cowork,
 * Apps, Forms, Notebooks) that the shell decides, because deciding it reads
 * features Studio may not import (hooks/useWorkspaceLinks).
 */

import React from 'react';

import { StudioScreen } from '@/features/studio';

import { useWorkspaceLinks } from '../hooks/useWorkspaceLinks';

export function StudioTabScreen() {
    return <StudioScreen workspace={useWorkspaceLinks()} />;
}
