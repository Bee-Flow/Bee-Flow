import { Bot } from 'lucide-react';
import React from 'react';
import type { RefObject } from 'react';
import InputArea from '../../components/chat/InputArea';
import MessageItem from '../../components/chat/MessageItem';
import KnowledgePanel from '../../components/knowledge/KnowledgePanel';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE } from '../../api/mutate';
import type { ModelTiers, TemplateChatMessage, TemplateRecord } from './templateTypes';

/** The assistant the template chat shows its answers as (MessageItem reads name and avatar). */
const TEMPLATE_ASSISTANT = { name: 'Template Assistant', avatar: '📝' };

/** The composer's props as this screen uses them; the rest of InputArea's props are optional at run time. */
interface TemplateInputAreaProps {
    onSendMessage: (text: string, attachments?: unknown[]) => void;
    onStopGenerating: () => void;
    isLoading: boolean;
    directMode: boolean;
    modelTiers: ModelTiers;
    selectedTier: string;
    onTierChange: (tier: string) => void;
    input: string;
    setInput: (value: string) => void;
}

// InputArea is JavaScript: its props are inferred from the destructuring, which makes every one required.
const TemplateInputArea = InputArea as React.ComponentType<TemplateInputAreaProps>;

export interface FillSettingsPanelProps {
    fillTemplate: TemplateRecord;
    editInstructions: string;
    setEditInstructions: (value: string) => void;
    saveInstructions: () => void;
    savingInstructions: boolean;
    handleKnowledgeBaseIdsChange: (ids: string[]) => void;
}

export function FillSettingsPanel({ fillTemplate, editInstructions, setEditInstructions, saveInstructions, savingInstructions, handleKnowledgeBaseIdsChange }: FillSettingsPanelProps) {
    const { t } = useTranslation();
    return (
        <div className="flex-1 overflow-auto p-6 custom-scrollbar">
            <div className="max-w-3xl mx-auto space-y-6">
                {/* Custom Instructions */}
                <div>
                    <h3 className="text-sm font-medium mb-2 text-[var(--text-primary)]">{t('templates.custom_instructions', 'Custom Instructions')}</h3>
                    <p className="text-xs mb-2 text-[var(--text-muted)]">
                        {t('templates.custom_instructions_hint', 'Add extra context or rules for the AI when filling this template.')}
                    </p>
                    <textarea
                        value={editInstructions}
                        onChange={e => setEditInstructions(e.target.value)}
                        onBlur={saveInstructions}
                        placeholder={t('templates.custom_instructions_placeholder', "e.g. 'Always use formal Dutch language', 'Company address is ...', 'Use metric units'")}
                        rows={4}
                        className="w-full px-4 py-3 rounded-xl border text-sm resize-y"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', background: 'var(--bg-tertiary)' }}
                    />
                    {savingInstructions && <span className="text-xs mt-1 block text-[var(--accent-primary)]">Saving...</span>}
                </div>

                {/* Knowledge Panel — same as Agent Editor */}
                <KnowledgePanel
                    API_BASE={API_BASE}
                    knowledgeBaseIds={fillTemplate.knowledgeBaseIds || []}
                    onKnowledgeBaseIdsChange={handleKnowledgeBaseIdsChange}
                />
            </div>
        </div>
    );
}

export interface FillChatPanelProps {
    parameterizing: boolean;
    chatMessages: TemplateChatMessage[];
    selectedNoteIds: string[];
    chatContainerRef: RefObject<HTMLDivElement | null>;
    chatEndRef: RefObject<HTMLDivElement | null>;
    chatInput: string;
    setChatInput: (value: string) => void;
    chatLoading: boolean;
    modelTiers: ModelTiers;
    selectedChatTier: string;
    setSelectedChatTier: (tier: string) => void;
    handleSendMessage: (text: string, attachments?: unknown[]) => void;
    stopChatGenerating: () => void;
    retryChatMessage: (idx: number, tierKey?: string) => void;
    editAndRegenerateChat: (idx: number, text: string) => void;
}

export function FillChatPanel({
    parameterizing, chatMessages, selectedNoteIds, chatContainerRef, chatEndRef, chatInput, setChatInput, chatLoading,
    modelTiers, selectedChatTier, setSelectedChatTier, handleSendMessage, stopChatGenerating, retryChatMessage, editAndRegenerateChat,
}: FillChatPanelProps) {
    const { t } = useTranslation();
    return (
        <>
            {/* Processing Banner */}
            {parameterizing && (
                <div className="mx-4 mt-3 flex items-center gap-3 px-4 py-3 rounded-xl border animate-pulse" style={{ background: 'rgba(99, 102, 241, 0.08)', borderColor: 'rgba(99, 102, 241, 0.2)' }}>
                    <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin flex-shrink-0" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
                    <div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">{t('templates.processing_title', 'AI is processing your template...')}</p>
                        <p className="text-xs text-[var(--text-muted)]">{t('templates.processing_text', 'Detecting parameters, generating instructions, and building knowledge base. This may take up to a minute.')}</p>
                    </div>
                </div>
            )}
            {/* Chat Messages */}
            <div ref={chatContainerRef} className="flex-1 overflow-auto p-4 custom-scrollbar">
                {chatMessages.length === 0 ? (
                    <div className="text-center py-12">
                        <Bot className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-muted)', opacity: 0.3 }} />
                        <p className="text-sm font-medium text-[var(--text-secondary)]">{t('templates.fill_empty_title', 'Fill this template with AI')}</p>
                        <p className="text-xs mt-1 max-w-sm mx-auto text-[var(--text-muted)]">
                            {t('templates.fill_empty_text', 'Describe what the document should contain. The AI will help you fill in all the parameters.')}
                            {selectedNoteIds.length > 0 && ' Meeting notes are loaded as context.'}
                        </p>
                        <div className="flex flex-wrap gap-1.5 justify-center mt-4">
                            {['Fill all parameters from context', 'What parameters need to be filled?', 'Help me fill this template'].map((q, i) => (
                                <button
                                    key={i}
                                    onClick={() => setChatInput(q)}
                                    className="text-[11px] px-2.5 py-1.5 rounded-lg border transition-all hover:border-[var(--accent-primary)]"
                                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="max-w-3xl mx-auto space-y-6 pb-4">
                        {chatMessages.filter(m => !m.parentId).map((msg, idx) => (
                            <MessageItem
                                key={msg.id || idx}
                                idx={idx}
                                msg={msg}
                                selectedAgent={TEMPLATE_ASSISTANT}
                                onCopy={(txt: unknown) => navigator.clipboard.writeText(String(txt))}
                                allMessages={chatMessages}
                                chatSource="direct"
                                onRetry={retryChatMessage}
                                onEditMessage={editAndRegenerateChat}
                                modelTiers={modelTiers}
                            />
                        ))}
                        <div ref={chatEndRef} />
                    </div>
                )}
            </div>

            {/* Input Area */}
            <div className="w-full flex flex-col shrink-0">
                <TemplateInputArea
                    onSendMessage={(text, attachments) => handleSendMessage(text, attachments)}
                    onStopGenerating={stopChatGenerating}
                    isLoading={chatLoading}
                    directMode={true}
                    modelTiers={modelTiers}
                    selectedTier={selectedChatTier}
                    onTierChange={setSelectedChatTier}
                    input={chatInput}
                    setInput={setChatInput}
                />
            </div>
        </>
    );
}
