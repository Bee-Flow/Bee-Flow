// Shared workspace → notebook loader. Replaces three copy-pasted blocks in
// AgentHub.jsx that each did the same thing:
//   GET the conversation's /workspace, then sync the linked notebook id and
//   the editor content, and show/hide the notebook pane depending on whether
//   the workspace had any content.
//
// The three copies — agent-conversation select, direct-conversation select,
// and the URL-deeplink auto-load — had drifted. The deeplink copy was missing
// the else-branch that clears the editor and hides the pane for an EMPTY
// workspace, so deeplinking into a conversation without a notebook left a
// stale notebook from a previously-open conversation on screen. Centralising
// the apply logic here keeps all three identical.
//
// Usage:
//   await loadWorkspaceNotebook(
//       `${API_BASE}/agents/${agentId}/conversations/${convId}/workspace`,
//       { setNotebookLinkedId, setNotebookContent, setShowNotebook },
//       { logLabel: 'Failed to fetch notebook' },
//   );

import { authFetch } from '../utils/helpers';

/** The notebook UI state the workspace response is applied to. */
export interface NotebookSetters {
    setNotebookLinkedId: (id: string | null) => void;
    setNotebookContent: (content: string) => void;
    setShowNotebook: (show: boolean) => void;
}

/** The parsed /workspace response body. */
export interface WorkspaceResponse {
    content?: string;
    notebookId?: string | null;
}

/**
 * Applies a parsed /workspace response to the notebook UI state. Shows the
 * pane with its content when the workspace is non-empty; otherwise clears the
 * editor and hides the pane. Always syncs the linked notebook id.
 *
 * `wsData` is the parsed response body.
 */
export function applyWorkspaceResponse(wsData: WorkspaceResponse | null | undefined, { setNotebookLinkedId, setNotebookContent, setShowNotebook }: NotebookSetters): void {
    const convContent = wsData?.content || '';
    setNotebookLinkedId(wsData?.notebookId || null);
    if (convContent.trim().length > 0) {
        setNotebookContent(convContent);
        setShowNotebook(true);
    } else {
        // New / empty conversation has no notebook — hide and clear so a
        // previously-open notebook doesn't linger on screen.
        setNotebookContent('');
        setShowNotebook(false);
    }
}

/**
 * Fetches a conversation's /workspace and applies it via applyWorkspaceResponse.
 * Fetch/parse errors are logged (using `logLabel`) and swallowed so a failed
 * workspace load never breaks conversation loading; the existing notebook is
 * left untouched on error.
 *
 * `url` is the full /workspace endpoint URL; `setters` are as for applyWorkspaceResponse.
 */
export async function loadWorkspaceNotebook(url: string, setters: NotebookSetters, { logLabel = 'Failed to fetch notebook' }: { logLabel?: string } = {}): Promise<void> {
    try {
        const wsRes = await authFetch(url);
        if (!wsRes.ok) return;
        const wsData = await wsRes.json();
        applyWorkspaceResponse(wsData, setters);
    } catch (err) {
        console.error(logLabel, err);
    }
}
