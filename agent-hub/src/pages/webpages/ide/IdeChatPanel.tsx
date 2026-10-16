import type { KeyboardEvent, MouseEvent } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import WebpageChat from '../WebpageChat';
import { ResizeHandle } from './IdeChrome';
import type { WebpageIDEProps } from './ideProps';

interface IdeChatPanelProps extends WebpageIDEProps {
    width: number;
    onResizeMouseDown: (e: MouseEvent) => void;
    onResizeKey: (e: KeyboardEvent, dir?: number) => void;
}

/**
 * The chat resize handle + panel on the right. The IDE unmounts it when
 * collapsed and owns its width, so a reopened panel keeps the width it had.
 */
export default function IdeChatPanel(p: IdeChatPanelProps) {
    const { t } = useTranslation();
    return (
        <>
            <ResizeHandle
                orientation="vertical"
                onMouseDown={p.onResizeMouseDown}
                onKeyDown={(e) => p.onResizeKey(e, -1)}
                label={t('webpages.ide.resize_chat', 'Resize chat panel')}
            />
            <div
                className="flex flex-col shrink-0"
                style={{ width: p.width, borderLeft: '1px solid var(--vsc-border)', background: 'var(--vsc-editor-bg)' }}
            >
                <WebpageChat
                    messages={p.chatMessages}
                    isLoading={p.chatLoading}
                    onSend={p.onChatSend}
                    onStop={p.onChatStop}
                    onRetry={p.onChatRetry}
                    onEdit={p.onChatEdit}
                    modelTiers={p.modelTiers}
                    selectedTier={p.selectedTier}
                    onTierChange={p.onTierChange}
                    onPlanApprove={p.onPlanApprove}
                    onPlanReject={p.onPlanReject}
                    onNewChat={p.onNewChat}
                    chatMode={p.chatMode}
                    onChatModeChange={p.onChatModeChange}
                    attachedSelection={p.attachedSelection}
                    onSelectionClear={p.onSelectionClear}
                    turnState={p.turnState}
                    onKeepTurn={p.onKeepTurn}
                    onUndoTurn={p.onUndoTurn}
                    onShowInCode={p.onShowInCode}
                />
            </div>
        </>
    );
}
