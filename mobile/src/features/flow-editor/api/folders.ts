/**
 * The sidebar folders (routes/automation/crud.js, /folders).
 *
 * One flat level, organisation-wide: anyone in the organisation can read and
 * edit a folder, while the automations inside stay per-user. Deleting a folder
 * DETACHES its automations — it never deletes one, because a folder may hold
 * automations of colleagues the deleting user cannot see. A duplicate name is a
 * 409 `folder_name_taken` (case-insensitive per organisation).
 */

import { api } from '@/core/api/client';

import { saveFlow } from './definition';
import { readFolderDeleted, readFolderList, readFolderResponse } from './linkReaders';
import type { FlowFolder, FolderBody, SaveResult } from './types';

const folderPath = (folderId: string) => `/api/automation/folders/${encodeURIComponent(folderId)}`;

export async function listFolders(signal?: AbortSignal): Promise<FlowFolder[]> {
    return readFolderList(await api.get<unknown>('/api/automation/folders', { signal }));
}

export async function createFolder(body: FolderBody): Promise<FlowFolder | null> {
    return readFolderResponse(await api.post<unknown>('/api/automation/folders', body, { retry: false }));
}

/** Every field optional: a rename does not resend the icon and the colour. */
export async function updateFolder(folderId: string, patch: Partial<FolderBody>): Promise<FlowFolder | null> {
    return readFolderResponse(await api.put<unknown>(folderPath(folderId), patch));
}

/** How many automations went back to the top level. */
export async function deleteFolder(folderId: string): Promise<number> {
    return readFolderDeleted(await api.delete<unknown>(folderPath(folderId), { retry: false }));
}

/** File an automation in a folder, or `null` to move it back to the top level. */
export function moveToFolder(id: string, folderId: string | null): Promise<SaveResult> {
    return saveFlow(id, { folderId });
}
