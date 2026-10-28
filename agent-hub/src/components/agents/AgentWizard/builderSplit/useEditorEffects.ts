import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ChatMessage } from '../agentEditor.types';
import type { EditorSnapshot } from '@/api/agentSaveTypes';
import type { EditorAgent, EditorPlan } from './editorTypes';
import { pickAgentAvatar, DEFAULT_AGENT_EMOJI } from '@/utils/agentAvatar';
import { logger } from '@/utils/logger';

/**
 * Mounted flag so async handlers can skip setState after unmount. Pair with
 * an AbortController fired on unmount so any new fetch initiated by the
 * editor (auto-save, draft create, knowledge picker bootstrap) can be wired
 * through it. Existing call sites that don't pass `signal:` still bail via
 * the mounted check before calling setState.
 */
export function useMountedRef() {
    const mountedRef = useRef(true);
    const unmountAbortRef = useRef<AbortController | null>(null);
    useEffect(() => {
        mountedRef.current = true;
        unmountAbortRef.current = new AbortController();
        return () => {
            mountedRef.current = false;
            try { unmountAbortRef.current?.abort(); } catch (err) { logger.debug('noop', err); }
        };
    }, []);
    return mountedRef;
}

/** Closes the skill picker when the mouse goes down outside the action bar. */
export function useSkillPickerOutsideClose(skillPickerOpen: boolean, setSkillPickerOpen: (open: boolean) => void, actionBarRef: RefObject<HTMLDivElement | null>) {
    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (skillPickerOpen && actionBarRef.current && !actionBarRef.current.contains(e.target as Node)) {
                setSkillPickerOpen(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [actionBarRef, setSkillPickerOpen, skillPickerOpen]);
}

interface SyncInputs {
    initialAgent: EditorAgent | null | undefined;
    plan: EditorPlan | null | undefined;
    agent: EditorAgent | null | undefined;
    name: string;
    instructions: string;
    description: string;
    instructionsEditing: boolean;
    instructionsTextareaRef: RefObject<HTMLTextAreaElement | null>;
    chat: ChatMessage[];
    chatScrollRef: RefObject<HTMLDivElement | null>;
    setSelectedTier: (tier: string) => void;
}

/**
 * The effects that keep refs and the view in step with the editor state:
 * the chat scrolls to the bottom, the tier pill follows the agent's tier, the
 * save snapshot (`stateRef`) follows the typed fields, the instructions
 * textarea takes focus when editing starts, and `agentIdRef` follows the id.
 *
 * ── Save pipeline ──
 * The PUT /agents/:id endpoint writes columns from whatever it receives
 * and falls back to NULL for description / systemPrompt when absent.
 * So every save MUST send the full canonical state. We keep the latest
 * values in a ref to coalesce rapid edits without stale closures.
 */
export function useEditorSync({ initialAgent, plan, agent, name, instructions, description, instructionsEditing, instructionsTextareaRef, chat, chatScrollRef, setSelectedTier }: SyncInputs) {
    // Stick to the bottom only when the user was already at (or near) the
    // bottom. If they've scrolled up to read history, don't yank them back —
    // that's why a user reading a long previous answer would lose their place
    // every time a new chunk streamed in.
    useEffect(() => {
        const el = chatScrollRef.current;
        if (!el) return;
        const STICK_THRESHOLD_PX = 80;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom <= STICK_THRESHOLD_PX) {
            el.scrollTop = el.scrollHeight;
        }
    }, [chat, chatScrollRef]);

    useEffect(() => {
        // Sync the chat-input tier pill with the agent's persisted tier on mount
        // (and on agent switch — useEffect re-runs when initialAgent.id changes
        // because BuilderSplit is keyed by it in AgentStudio).
        if (initialAgent?.model && initialAgent.model.startsWith('tier:')) {
            setSelectedTier(initialAgent.model.slice('tier:'.length));
        }
    }, [initialAgent?.id, initialAgent?.model, setSelectedTier]);

    const stateRef = useRef<EditorSnapshot>({
        name,
        description: initialAgent?.description || plan?.description || '',
        systemPrompt: instructions,
        model: initialAgent?.model || '',
        categoryId: initialAgent?.category_id || null,
        embedEnabled: initialAgent?.embed_enabled === 1 || initialAgent?.embed_enabled === true,
        avatar: pickAgentAvatar(initialAgent) || plan?.avatar || DEFAULT_AGENT_EMOJI,
        config: { ...(initialAgent?.config || {}) },
    });
    useEffect(() => { stateRef.current.name = name; }, [name]);
    useEffect(() => { stateRef.current.systemPrompt = instructions; }, [instructions]);
    useEffect(() => { stateRef.current.description = description; }, [description]);
    useEffect(() => {
        if (instructionsEditing && instructionsTextareaRef.current) {
            const el = instructionsTextareaRef.current;
            el.focus();
            const len = el.value.length;
            el.setSelectionRange(len, len);
        }
    }, [instructionsEditing, instructionsTextareaRef]);

    const agentIdRef = useRef<string | null | undefined>(agent?.id);
    useEffect(() => { agentIdRef.current = agent?.id; }, [agent?.id]);

    // Local dirty flag — drives the parent's unsaved-changes guard and the
    // best-effort beforeunload beacon. The autosave hook keeps its OWN dirty
    // flag for the save loop; this one is UX-only.
    const dirtyRef = useRef(false);

    return { stateRef, agentIdRef, dirtyRef };
}
