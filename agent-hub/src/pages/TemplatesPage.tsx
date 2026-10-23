import { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE, mutate } from '../api/mutate';
import { createTemplateActions } from './templates/templateActions';
import useConfirm from '../components/shared/useConfirm';
import useChatEngine from '../hooks/useChatEngine';
import TemplateFillView from './templates/TemplateFillView';
import TemplateListView from './templates/TemplateListView';
import { fetchTemplateList, startProcessingPoll, useModelTiersLoader, usePollersRef } from './templates/templatePolling';
import { useTemplateAutoGenerate } from './templates/useTemplateAutoGenerate';
import { useTemplateChatOptions } from './templates/useTemplateChatOptions';
import InputArea from '../components/chat/InputArea';
import { toast } from '../components/shared/Toast';
import type { TemplateRecord } from './templates/templateTypes';
import type { RetryModelTiers } from '../components/chat/MessageItem/MessageActionsRow';
import { ChatAttachment } from '../hooks/useChatEngine/historyAttachment';

interface TemplatesPageProps {
    user: { id?: string } | null;
    onBack: () => void;
}

export default function TemplatesPage({ user, onBack }: TemplatesPageProps) {
    // Template list state
    const [templates, setTemplates] = useState<TemplateRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    // Upload state
    const [uploading, setUploading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Active polling intervals (cleared on unmount)
    const pollersRef = usePollersRef();

    // Rename state
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    // Delete state
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const { confirm, confirmDialog } = useConfirm();

    // AI Fill view state
    const [fillTemplate, setFillTemplate] = useState<TemplateRecord | null>(null); // template being filled
    const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
    const [generating, setGenerating] = useState(false);
    const [parameterizing, setParameterizing] = useState(false);
    const [skipAiDetection, setSkipAiDetection] = useState(false);

    // Template settings state
    const [showSettings, setShowSettings] = useState(false);
    const [editInstructions, setEditInstructions] = useState('');
    const [savingInstructions, setSavingInstructions] = useState(false);

    // Chat state
    const [selectedChatTier, setSelectedChatTier] = useState('auto');
    const [modelTiers, setModelTiers] = useState<RetryModelTiers>({});
    const [chatInput, setChatInput] = useState('');
    const chatEndRef = useRef<HTMLDivElement>(null);
    const chatContainerRef = useRef<HTMLDivElement>(null);

    // useChatEngine — routes through dedicated template chat endpoint
    const { messages: chatMessages, setMessages: setChatMessages, isLoading: chatLoading, sendMessage: sendChatMessage, stopGenerating: stopChatGenerating, retryMessage: retryChatMessage, editAndRegenerate: editAndRegenerateChat } = useChatEngine(useTemplateChatOptions(selectedChatTier, fillTemplate, selectedNoteIds));

    // Load templates
    const loadTemplates = useCallback(() => fetchTemplateList(setTemplates, setLoading), []);


    useEffect(() => { loadTemplates(); }, [loadTemplates]);

    // Load model tiers
    useModelTiersLoader(setModelTiers);

    // What the background polls feed (see templates/templatePolling)
    const pollDeps = { pollersRef, setParameterizing, setFillTemplate, setEditInstructions, loadTemplates };

    // Reset chat when changing template + detect if still processing
    useEffect(() => {
        setChatMessages([]);
        setChatInput('');
        setSelectedNoteIds([]);
        if (fillTemplate) {
            setEditInstructions(fillTemplate.instructions || '');

            // Auto-detect if this template is still being processed
            // (0 parameters AND no description = AI is still working)
            const isStillProcessing = fillTemplate.parameters.length === 0 && !fillTemplate.description;
            if (isStillProcessing) {
                setParameterizing(true);
                return startProcessingPoll(fillTemplate.id, pollDeps);
            } else {
                setParameterizing(false);
            }
        }
    }, [fillTemplate?.id]);

    // Auto-generate document when AI outputs a JSON block with parameter values
    useTemplateAutoGenerate(fillTemplate, chatMessages, chatLoading, setChatMessages);

    const { handleUpload, handleRename, handleDelete, handleDownload, handleGenerate } = createTemplateActions({
        fillTemplate, renameValue, skipAiDetection, chatMessages,
        ...pollDeps,
        setTemplates, setUploading, setGenerating, setRenamingId, setDeletingId,
        sendChatMessage,
    });

    // Save instructions
    const saveInstructions = async () => {
        if (!fillTemplate) return;
        setSavingInstructions(true);
        try {
            await mutate(`${API_BASE}/api/templates/${fillTemplate.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instructions: editInstructions }),
            });
            setFillTemplate(prev => ({ ...(prev as TemplateRecord), instructions: editInstructions }));
        } catch (err) { console.error('Save instructions failed:', err); toast.error((err as Error).message); }
        finally { setSavingInstructions(false); }
    };

    // KB ID changes — persist to template
    const handleKnowledgeBaseIdsChange = async (newIds: string[]) => {
        if (!fillTemplate) return;
        setFillTemplate(prev => ({ ...(prev as TemplateRecord), knowledgeBaseIds: newIds }));
        try {
            await mutate(`${API_BASE}/api/templates/${fillTemplate.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ knowledgeBaseIds: newIds }),
            });
        } catch (err) { console.error('Save KB IDs failed:', err); toast.error((err as Error).message); }
    };

    // Auto-scroll chat
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages]);

    if (fillTemplate) {
        return (
            <TemplateFillView
                fillTemplate={fillTemplate}
                parameterizing={parameterizing}
                showSettings={showSettings}
                setShowSettings={setShowSettings}
                generating={generating}
                hasMessages={chatMessages.length > 0}
                onClose={() => setFillTemplate(null)}
                onGenerate={handleGenerate}
                selectedNoteIds={selectedNoteIds}
                setSelectedNoteIds={setSelectedNoteIds}
                editInstructions={editInstructions}
                setEditInstructions={setEditInstructions}
                saveInstructions={saveInstructions}
                savingInstructions={savingInstructions}
                handleKnowledgeBaseIdsChange={handleKnowledgeBaseIdsChange}
                chatMessages={chatMessages}
                chatContainerRef={chatContainerRef}
                chatEndRef={chatEndRef}
                setChatInput={setChatInput}
                inputArea={(
                    <InputArea
                        onSendMessage={(text: string, attachments: ChatAttachment[]|undefined) => sendChatMessage(text, attachments)}
                        onStopGenerating={stopChatGenerating}
                        isLoading={chatLoading}
                        directMode={true}
                        modelTiers={modelTiers}
                        selectedTier={selectedChatTier}
                        onTierChange={setSelectedChatTier}
                        input={chatInput}
                        setInput={setChatInput}
                    />
                )}
                modelTiers={modelTiers}
                retryChatMessage={retryChatMessage}
                editAndRegenerateChat={editAndRegenerateChat}
            />
        );
    }

    // ── Template List View ────────────────────────────────────────
    return (
        <TemplateListView
            onBack={onBack}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            uploading={uploading}
            skipAiDetection={skipAiDetection}
            setSkipAiDetection={setSkipAiDetection}
            fileInputRef={fileInputRef}
            handleUpload={handleUpload}
            loading={loading}
            templates={templates}
            dragOver={dragOver}
            setDragOver={setDragOver}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            handleRename={handleRename}
            deletingId={deletingId}
            handleDelete={handleDelete}
            handleDownload={handleDownload}
            setFillTemplate={setFillTemplate}
            confirm={confirm}
            confirmDialog={confirmDialog}
        />
    );
}
