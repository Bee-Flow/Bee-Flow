import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * Editing a user message in place: the draft, the textarea that grows with it
 * (as the composer does, up to 180px), focus + select-all on entering, Escape
 * to cancel and Cmd/Ctrl+Enter to send. Split out of MessageItem without a
 * change in behaviour.
 */
export function useMessageEdit(idx: number, onEditMessage: ((idx: number, text: string) => void) | null | undefined) {
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const editTextareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-resize edit textarea (mirrors InputArea behavior)
    useEffect(() => {
        const el = editTextareaRef.current;
        if (!isEditing || !el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }, [editContent, isEditing]);

    // Focus + select-all when entering edit mode
    useEffect(() => {
        if (isEditing && editTextareaRef.current) {
            editTextareaRef.current.focus();
            editTextareaRef.current.select();
        }
    }, [isEditing]);

    const submitEdit = () => {
        const trimmed = editContent.trim();
        if (trimmed && onEditMessage) {
            onEditMessage(idx, trimmed);
            setIsEditing(false);
        }
    };

    const handleEditKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsEditing(false);
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submitEdit();
        }
    };

    const startEdit = (content: string | null | undefined) => { setIsEditing(true); setEditContent(content || ''); };

    return { isEditing, setIsEditing, editContent, setEditContent, editTextareaRef, submitEdit, handleEditKeyDown, startEdit };
}

type SimpleModeWindow = Window & { __beeflowSimpleMode?: boolean };

/**
 * Simple Mode hides the "How I got this answer" panel and the reasoning.
 * AgentHub keeps window.__beeflowSimpleMode and dispatches
 * `beeflow:simpleModeChanged` when the user toggles the preference; this
 * subscribes so the panels disappear without prop-drilling through every
 * MessageItem caller.
 */
export function useSimpleMode(): boolean {
    const [simpleMode, setSimpleMode] = useState(() => typeof window !== 'undefined' && !!(window as SimpleModeWindow).__beeflowSimpleMode);
    useEffect(() => {
        const handler = (e: Event) => setSimpleMode(!!(e as CustomEvent)?.detail);
        window.addEventListener('beeflow:simpleModeChanged', handler);
        return () => window.removeEventListener('beeflow:simpleModeChanged', handler);
    }, []);
    return simpleMode;
}
