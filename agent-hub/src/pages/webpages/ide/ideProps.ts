import type useChatEngine from '../../../hooks/useChatEngine';
import type { ChatAttachment } from '../../../hooks/useChatEngine/historyAttachment';
import type { ChatMessage } from '../../../hooks/useChatEngine/types';
import type { RetryModelTiers } from '../../../components/chat/MessageItem/MessageActionsRow';
import type { PreviewSelection } from '../preview/usePreviewToken';
import type { WebpageSource } from '../WebpageSources';
import type { ContentSetter, ExtraContents, ExtraFileMeta, WebpageRow } from '../webpageEditorTypes';

type ChatEngine = ReturnType<typeof useChatEngine>;

/** The per-turn chip state the chat panel shows under an assistant reply. */
export interface TurnState {
    canUndo: boolean;
    undone: boolean;
    kept: boolean;
}

export interface WebpageIDEProps {
    // Webpage data
    selected: WebpageRow;
    html: string;
    css: string;
    js: string;
    onHtmlChange?: ContentSetter;
    onCssChange?: ContentSetter;
    onJsChange?: ContentSetter;
    dirtyFiles?: Record<string, boolean>;
    extraFiles?: ExtraFileMeta[];
    extraContents?: ExtraContents;
    /** Text-only extras. */
    onExtraChange?: (path: string, newContent: string) => void;
    // Manual file / asset management
    onCreateFile?: (path: string) => unknown;
    onRenameFile?: (oldPath: string, newPath: string) => unknown;
    onDeleteFile?: (path: string) => unknown;
    onUploadAsset?: (file: File, folder?: string) => unknown;
    sources: WebpageSource[];
    onSourcesChange: (sources: WebpageSource[]) => void;
    // Chat
    chatMessages: ChatMessage[];
    chatLoading?: boolean;
    onChatSend: (text: string, attachments: ChatAttachment[]) => void;
    onChatStop?: () => void;
    onChatRetry?: ChatEngine['retryMessage'];
    onChatEdit?: ChatEngine['editAndRegenerate'];
    onPlanApprove?: (planId: string) => void;
    onPlanReject?: (planId: string) => void;
    onNewChat?: () => unknown;
    chatMode?: string;
    onChatModeChange?: (mode: string) => void;
    onSelectionAttach?: (selection: PreviewSelection) => void;
    attachedSelection?: { text: string } | null;
    onSelectionClear?: () => void;
    modelTiers: RetryModelTiers;
    selectedTier?: string;
    onTierChange?: (tier: string) => void;
    // Save
    saveState?: string;
    lastSavedAt?: Date | null;
    onRetrySave?: () => unknown;
    onVersionsClick?: () => void;
    onDownload?: () => unknown;
    /** Used for the owner gate (file management is owner-only). */
    user?: { id?: string } | null;
    /*
     * W2: the header may drive the developer view. `devMode`/`onDevModeChange`
     * make the code toggle CONTROLLED. Left undefined (the standalone case)
     * the IDE keeps its own persisted state, so nothing that mounted this
     * before W2 changed behaviour. `hideHoistedActions` drops the buttons that
     * moved into the section header — Add image, ZIP, History and the Code
     * toggle itself — rather than showing two of each and letting them
     * disagree.
     */
    devMode?: boolean;
    onDevModeChange?: (next: boolean) => void;
    hideHoistedActions?: boolean;
    // Per-turn chip state, passed straight through to the chat panel.
    turnState?: (msgId: string) => TurnState;
    onKeepTurn?: (msgId: string) => void;
    onUndoTurn?: (msgId: string) => void;
    onShowInCode?: (file?: string) => void;
    /**
     * A file the caller wants opened in the editor ('html'|'css'|'js'|
     * 'extra:<path>'), as `{ key, at }`. `at` is a monotonically rising stamp
     * so asking twice for the SAME file still re-focuses it — a plain string
     * would be equal to itself and the second request would do nothing.
     */
    focusFile?: { key: string; at: number } | null;
    /**
     * A page a Solution stage manages: read-only whoever opens it, and no AI
     * builder (a deploy owns what it holds). The page GET's `managed`.
     */
    managed?: unknown;
}
