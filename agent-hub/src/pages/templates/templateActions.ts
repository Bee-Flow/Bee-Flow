import type { Dispatch, SetStateAction } from 'react';
import { toast } from '../../components/shared/Toast';
import { API_BASE, mutate } from '../../api/mutate';
import { templatesApi } from '../../api/templatesApi';
import { errorMessage, messageOf } from '../../utils/caughtError';
import { startUploadPoll } from './templatePolling';
import type { PollDeps } from './templatePolling';
import type { TemplateChatMessage, TemplateRecord } from './templateTypes';

/** What the handlers read and write: the page's state and setters. */
export interface TemplateActionsDeps extends PollDeps {
    fillTemplate: TemplateRecord | null;
    editInstructions: string;
    renameValue: string;
    skipAiDetection: boolean;
    chatMessages: TemplateChatMessage[];
    setTemplates: Dispatch<SetStateAction<TemplateRecord[]>>;
    setUploading: (value: boolean) => void;
    setGenerating: (value: boolean) => void;
    setSavingInstructions: (value: boolean) => void;
    setRenamingId: (id: string | null) => void;
    setDeletingId: (id: string | null) => void;
    sendChatMessage: (text: string) => void;
}

/** The template screen's server actions (save, upload, rename, delete, download, generate). */
export function createTemplateActions(deps: TemplateActionsDeps) {
    const {
        fillTemplate, editInstructions, renameValue, skipAiDetection, chatMessages, pollersRef,
        setTemplates, setUploading, setGenerating, setSavingInstructions, setRenamingId, setDeletingId,
        setFillTemplate, setEditInstructions, setParameterizing, loadTemplates, sendChatMessage,
    } = deps;

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
            setFillTemplate(prev => (prev ? { ...prev, instructions: editInstructions } : prev));
        } catch (err) { console.error('Save instructions failed:', err); toast.error(messageOf(err, 'Save failed')); }
        finally { setSavingInstructions(false); }
    };

    // KB ID changes — persist to template
    const handleKnowledgeBaseIdsChange = async (newIds: string[]) => {
        if (!fillTemplate) return;
        setFillTemplate(prev => (prev ? { ...prev, knowledgeBaseIds: newIds } : prev));
        try {
            await mutate(`${API_BASE}/api/templates/${fillTemplate.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ knowledgeBaseIds: newIds }),
            });
        } catch (err) { console.error('Save KB IDs failed:', err); toast.error(messageOf(err, 'Save failed')); }
    };

    // Upload handler
    const handleUpload = async (file: File) => {
        if (!file || !file.name.toLowerCase().endsWith('.docx')) {
            toast.error('Please select a .docx file');
            return;
        }

        setUploading(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('name', file.name.replace(/\.docx$/i, ''));
            if (skipAiDetection) formData.append('skipAutoParameterize', 'true');

            const res = await templatesApi.upload(formData);

            if (res.ok) {
                const data = await res.json();
                await loadTemplates();

                // Auto-open the new template
                if (data.template) {
                    setFillTemplate(data.template);
                }

                // If context is being generated in the background, poll for updates
                if (data.generatingContext && data.template?.id) {
                    const origParamCount = data.template.parameters?.length || 0;
                    if (origParamCount === 0) setParameterizing(true);
                    startUploadPoll(data.template, origParamCount, deps);
                }
            } else {
                const err = await res.json();
                toast.error(err.error || 'Upload failed');
            }
        } catch (err) {
            toast.error('Upload failed: ' + errorMessage(err));
        } finally {
            setUploading(false);
        }
    };

    // Rename handler
    const handleRename = async (id: string) => {
        if (!renameValue.trim()) return;
        try {
            const res = await templatesApi.rename(id, renameValue.trim());
            if (res.ok) {
                setTemplates(prev => prev.map(t => t.id === id ? { ...t, name: renameValue.trim() } : t));
            }
        } catch (err) {
            console.error('Rename failed:', err);
        }
        setRenamingId(null);
    };

    // Delete handler
    const handleDelete = async (id: string) => {
        setDeletingId(id);
        try {
            const res = await templatesApi.remove(id);
            if (res.ok) {
                setTemplates(prev => prev.filter(t => t.id !== id));
                if (fillTemplate?.id === id) setFillTemplate(null);
            }
        } catch (err) {
            console.error('Delete failed:', err);
        }
        setDeletingId(null);
    };

    // Download handler
    const handleDownload = async (template: TemplateRecord) => {
        try {
            const res = await templatesApi.download(template.id);
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = template.fileName ?? '';
                a.click();
                URL.revokeObjectURL(url);
            }
        } catch (err) {
            console.error('Download failed:', err);
        }
    };

    // Generate filled document
    const handleGenerate = async () => {
        if (!fillTemplate) return;

        // Find the last JSON code block in chat messages
        const assistantMessages = chatMessages.filter(m => m.role === 'assistant' && m.content);
        let values = null;

        for (let i = assistantMessages.length - 1; i >= 0; i--) {
            const content = assistantMessages[i].content ?? '';
            const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
            if (jsonMatch) {
                try {
                    values = JSON.parse(jsonMatch[1]);
                    break;
                } catch (e) {
                    continue;
                }
            }
        }

        if (!values) {
            // Ask AI to generate values
            sendChatMessage('Please fill all the template parameters based on our conversation. Respond with a JSON code block containing all parameter values.');
            return;
        }

        setGenerating(true);
        try {
            const res = await templatesApi.fill(fillTemplate.id, values);

            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = (fillTemplate.fileName ?? '').replace(/\.docx$/i, '_filled.docx');
                a.click();
                URL.revokeObjectURL(url);
            } else {
                const err = await res.json();
                toast.error(err.error || 'Failed to generate document');
            }
        } catch (err) {
            toast.error('Failed to generate document: ' + errorMessage(err));
        } finally {
            setGenerating(false);
        }
    };

    return { saveInstructions, handleKnowledgeBaseIdsChange, handleUpload, handleRename, handleDelete, handleDownload, handleGenerate };
}
