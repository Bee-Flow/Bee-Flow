import { useEffect, useRef, useEffectEvent } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { API_BASE } from '../../api/mutate';
import { templatesApi } from '../../api/templatesApi';
import { errorMessage } from '../../utils/caughtError';
import { logger } from '../../utils/logger';
import type { TemplateChatMessage, TemplateRecord } from './templateTypes';

/**
 * When the assistant's last (finished) answer holds a JSON code block with
 * parameter values, fills the template with them, downloads the result and
 * reports progress as a system message in the chat. Each message is handled once.
 */
export function useTemplateAutoGenerate(
    fillTemplate: TemplateRecord | null,
    chatMessages: TemplateChatMessage[],
    chatLoading: boolean,
    setChatMessages: Dispatch<SetStateAction<TemplateChatMessage[]>>,
): void {
    const processedJsonMsgIds = useRef(new Set());
    const runFillTemplateEffect = useEffectEvent(() => {
        if (!fillTemplate || chatLoading) return;
        const lastMsg = chatMessages[chatMessages.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.isStreaming) return;
        if (processedJsonMsgIds.current.has(lastMsg.id)) return;

        // Check for JSON code block
        const jsonMatch = lastMsg.content?.match(/```json\s*\n([\s\S]*?)\n```/);
        if (!jsonMatch) return;

        try {
            const values = JSON.parse(jsonMatch[1]);
            if (!values || typeof values !== 'object') return;

            // Mark as processed
            processedJsonMsgIds.current.add(lastMsg.id);

            // Auto-generate document
            (async () => {
                // Add a generating message
                const genMsgId = `gen-${Date.now()}`;
                setChatMessages(prev => [...prev, {
                    id: genMsgId,
                    role: 'assistant',
                    content: '⏳ Generating your document...',
                    isSystem: true,
                }]);

                try {
                    const res = await templatesApi.fillAndStore(fillTemplate.id, values);

                    if (res.ok) {
                        const { downloadUrl, fileName } = await res.json();
                        const fullDownloadUrl = downloadUrl.startsWith('http') ? downloadUrl : `${API_BASE}${downloadUrl}`;
                        
                        // Trigger authenticated download immediately
                        try {
                            const dlRes = await templatesApi.file(fullDownloadUrl);
                            if (dlRes.ok) {
                                const blob = await dlRes.blob();
                                const blobUrl = URL.createObjectURL(blob);
                                try {
                                    const a = document.createElement('a');
                                    a.href = blobUrl;
                                    a.download = fileName;
                                    document.body.appendChild(a);
                                    a.click();
                                    document.body.removeChild(a);
                                } finally {
                                    // Revoke after click handlers have fired; if anything between
                                    // createObjectURL and click threw, this still runs.
                                    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                                }
                            }
                        } catch (dlErr) {
                            console.warn('Auto-download failed:', dlErr);
                        }

                        setChatMessages(prev => prev.map(m => m.id === genMsgId ? {
                            ...m,
                            content: `✅ **Document generated!**\n\n📄 [Download ${fileName}](${fullDownloadUrl})`,
                            _downloadUrl: fullDownloadUrl,
                            _downloadFileName: fileName,
                        } : m));
                    } else {
                        const err = await res.json().catch(() => ({}));
                        setChatMessages(prev => prev.map(m => m.id === genMsgId ? {
                            ...m,
                            content: `❌ Failed to generate document: ${err.error || 'Unknown error'}`,
                        } : m));
                    }
                } catch (err) {
                    setChatMessages(prev => prev.map(m => m.id === genMsgId ? {
                        ...m,
                        content: `❌ Failed to generate document: ${errorMessage(err)}`,
                    } : m));
                }
            })();
        } catch (e) {
            // JSON.parse threw — the assistant emitted a code block that
            // wasn't valid JSON. Safe to ignore at the user level, but log
            // for telemetry so a regression in the model prompt is visible.
            logger.debug('[TemplatesPage] JSON parameter block parse skipped', e);
        }
    });
    useEffect(() => { return runFillTemplateEffect(); }, [chatMessages, chatLoading, fillTemplate?.id]);
}
