/**
 * WorkspaceNotebook — Replaces the old WorkspacePanel.
 *
 * Wraps NotebookEditor in a minimal container: header bar + editor,
 * no sources sidebar, no chat panel.
 *
 * IMPORTANT: We pass a STABLE `initialContent` to NotebookEditor (never
 * changes after mount). All subsequent external updates are pushed via ref.
 */
export interface WorkspaceNotebookProps {
    content: string;
    onClose?: () => void;
    conversationId: string | null | undefined;
    existingNotebookId: string | null | undefined;
    onChange?: (md: string) => void;
    onSave?: (md: string, notebookId?: string) => unknown;
    onSelectionChange?: (text: string) => void;
    onAskAI?: (message: string) => void;
    onOpenInNotebook?: (md: string, notebookId: string | null) => unknown;
    onNotebookIdChange?: (id: string | null) => void;
    user?: { featureFlags?: { export?: boolean; openInNotebook?: boolean; askAi?: boolean; [key: string]: boolean | undefined } } | null;
}
