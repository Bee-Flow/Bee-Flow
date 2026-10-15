import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { API_BASE, authFetch } from '../api/mutate';
import { createTemplateActions } from './templates/templateActions';
import useConfirm from '../components/shared/useConfirm';
import useChatEngine from '../hooks/useChatEngine';
import TemplateFillView from './templates/TemplateFillView';
import TemplateListView from './templates/TemplateListView';
import { fetchTemplateList, startProcessingPoll } from './templates/templatePolling';
import { useTemplateAutoGenerate } from './templates/useTemplateAutoGenerate';

export default function TemplatesPage({ user, onBack }) {
    // Template list state
    const [templates, setTemplates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    // Upload state
    const [uploading, setUploading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef(null);

    // Active polling intervals — cleared on unmount so navigating away mid-
    // upload or mid-template-detect doesn't leak repeating fetches.
    const pollersRef = useRef(new Set());
    useEffect(() => () => {
        pollersRef.current.forEach(clearInterval);
        pollersRef.current.clear();
    }, []);

    // Rename state
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');

    // Delete state
    const [deletingId, setDeletingId] = useState(null);
    const { confirm, confirmDialog } = useConfirm();

    // AI Fill view state
    const [fillTemplate, setFillTemplate] = useState(null); // template being filled
    const [selectedNoteIds, setSelectedNoteIds] = useState([]);
    const [generating, setGenerating] = useState(false);
    const [parameterizing, setParameterizing] = useState(false);
    const [skipAiDetection, setSkipAiDetection] = useState(false);

    // Template settings state
    const [showSettings, setShowSettings] = useState(false);
    const [editInstructions, setEditInstructions] = useState('');
    const [savingInstructions, setSavingInstructions] = useState(false);

    // Chat state
    const [selectedChatTier, setSelectedChatTier] = useState('auto');
    const [modelTiers, setModelTiers] = useState({});
    const [chatInput, setChatInput] = useState('');
    const chatEndRef = useRef(null);
    const chatContainerRef = useRef(null);

    // useChatEngine — routes through dedicated template chat endpoint
    const { messages: chatMessages, setMessages: setChatMessages, isLoading: chatLoading, sendMessage: sendChatMessage, stopGenerating: stopChatGenerating, retryMessage: retryChatMessage, editAndRegenerate: editAndRegenerateChat } = useChatEngine({
        selectedAgent: null,
        currentConversation: null,
        onConversationCreated: useCallback(() => {}, []),
        getNotebookPayload: useCallback(() => ({}), []),
        onNotebookUpdate: useCallback(() => {}, []),
        directMode: useMemo(() => ({
            enabled: true,
            modelTier: selectedChatTier,
            customEndpoint: fillTemplate ? '/ai/chat/template/stream' : undefined,
            getExtraPayload: () => fillTemplate ? {
                templateId: fillTemplate.id,
                meetingNoteIds: selectedNoteIds,
            } : {},
        }), [selectedChatTier, fillTemplate?.id, selectedNoteIds]),
        onDirectConversationCreated: useCallback(() => {}, []),
    });

    // Load templates
    const loadTemplates = useCallback(() => fetchTemplateList(setTemplates, setLoading), []);


    useEffect(() => { loadTemplates(); }, [loadTemplates]);

    // Load model tiers
    useEffect(() => {
        authFetch(`${API_BASE}/ai/config/chat-models`)
            .then(r => r.ok ? r.json() : {})
            .then(data => setModelTiers(data))
            .catch(e => console.warn('[TemplatesPage] load model tiers failed', e));
    }, []);

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

    const { saveInstructions, handleKnowledgeBaseIdsChange, handleUpload, handleRename, handleDelete, handleDownload, handleGenerate } = createTemplateActions({
        fillTemplate, editInstructions, renameValue, skipAiDetection, chatMessages,
        ...pollDeps,
        setTemplates, setUploading, setGenerating, setSavingInstructions, setRenamingId, setDeletingId,
        sendChatMessage,
    });


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
                chatInput={chatInput}
                setChatInput={setChatInput}
                chatLoading={chatLoading}
                modelTiers={modelTiers}
                selectedChatTier={selectedChatTier}
                setSelectedChatTier={setSelectedChatTier}
                handleSendMessage={sendChatMessage}
                stopChatGenerating={stopChatGenerating}
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
