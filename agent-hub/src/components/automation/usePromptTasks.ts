import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { formatNextRun } from './taskFormatters';
import { API_BASE, authFetch } from '../../utils/helpers';
import { toast } from '../shared/Toast';

/** One scheduled agent routine, as GET /api/ai-tasks returns it. */
export interface PromptTask {
    id: string;
    title?: string;
    prompt?: string;
    /** Agent-linked rows only — a plain prompt task moved to Cowork. */
    agentId?: string | null;
    nextRunAt?: string | null;
    repeatInterval?: string | null;
    modelTier?: string | null;
    isActive?: boolean;
    [key: string]: unknown;
}

/** One of the user's own agents, for the assignment selector. */
export interface TaskAgent {
    id: string;
    name?: string;
    [key: string]: unknown;
}

/** A finished run the list offers to show. */
export interface TaskResultModal {
    title?: string;
    content?: string;
    [key: string]: unknown;
}

export interface PromptTasks {
    tasks: PromptTask[];
    loading: boolean;
    maxTasks: number;
    agents: TaskAgent[];
    resultModal: TaskResultModal | null;
    setResultModal: Dispatch<SetStateAction<TaskResultModal | null>>;
    pendingDeleteTask: PromptTask | null;
    setPendingDeleteTask: Dispatch<SetStateAction<PromptTask | null>>;
    /** A task id while editing, 'new' while creating, null in the list view. */
    editingTaskId: string | null;
    title: string;
    setTitle: Dispatch<SetStateAction<string>>;
    prompt: string;
    setPrompt: Dispatch<SetStateAction<string>>;
    date: string;
    setDate: Dispatch<SetStateAction<string>>;
    time: string;
    setTime: Dispatch<SetStateAction<string>>;
    repeatInterval: string;
    setRepeatInterval: Dispatch<SetStateAction<string>>;
    tier: string;
    setTier: Dispatch<SetStateAction<string>>;
    agentId: string;
    setAgentId: Dispatch<SetStateAction<string>>;
    activeTasks: PromptTask[];
    inactiveTasks: PromptTask[];
    editing: boolean;
    isNewMode: boolean;
    canSave: boolean;
    /** "Tomorrow at 09:00", or null while the form has no date and time yet. */
    nextRunPreview: string | null;
    fetchTasks: () => Promise<void>;
    resetForm: () => void;
    startNewTask: () => void;
    startEditTask: (task: PromptTask) => void;
    saveTask: () => Promise<void>;
    toggleTask: (id: string) => Promise<void>;
    requestDeleteTask: (task: PromptTask) => void;
    confirmDeleteTask: () => Promise<void>;
    runTaskNow: (id: string) => Promise<void>;
    openInDirectChat: (title: string | undefined, content: string | undefined) => void;
}

export interface UsePromptTasksOptions {
    /** Without the entitlement there is no agent list and no agentId to send. */
    routinesAllowed: boolean;
}

/**
 * The prompt-task half of the designer: the list, the one form that edits a
 * task, and the calls behind both. Agent-linked rows only — plain prompt
 * tasks moved to Cowork.
 *
 * `routinesAllowed` gates the agent selector: without the entitlement there
 * is no agent list to fetch and no agentId to send.
 */
export default function usePromptTasks({ routinesAllowed }: UsePromptTasksOptions): PromptTasks {
    const [tasks, setTasks] = useState<PromptTask[]>([]);
    const [loading, setLoading] = useState(false);
    const [maxTasks, setMaxTasks] = useState(10);
    const [resultModal, setResultModal] = useState<TaskResultModal | null>(null);
    const [pendingDeleteTask, setPendingDeleteTask] = useState<PromptTask | null>(null);

    // Editor view state — null means list/idle view
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null); // a task id = edit, 'new' = create
    const [title, setTitle] = useState('');
    const [prompt, setPrompt] = useState('');
    const [date, setDate] = useState('');
    const [time, setTime] = useState('');
    const [repeatInterval, setRepeatInterval] = useState('weekly');
    const [tier, setTier] = useState('auto');
    const [agentId, setAgentId] = useState('');
    const [agents, setAgents] = useState<TaskAgent[]>([]);

    const fetchTasks = useCallback(async () => {
        setLoading(true);
        try {
            const res = await authFetch(`${API_BASE}/api/ai-tasks`);
            if (res.ok) {
                const data: { tasks?: PromptTask[]; maxTasks?: number } = await res.json();
                // Agent-linked rows only. Plain prompt tasks were migrated into
                // Cowork (see server/migrations/prompt-tasks-to-cowork-2026-08)
                // and their originals are left behind, deactivated, purely as a
                // rollback copy — listing them here would show a paused
                // duplicate of something the user can see running under Cowork.
                // Agent routines stay: they run through the agent runtime and
                // are created and managed from the Agent Wizard.
                setTasks((data.tasks || []).filter(t => t.agentId));
                if (data.maxTasks) setMaxTasks(data.maxTasks);
            } else {
                console.error('[AITasksDesigner] fetchTasks failed:', res.status, res.statusText);
            }
        } catch (err) {
            // Promoted from a silent catch — at minimum surface in devtools
            // so a misconfigured route shows up during QA.
            console.error('[AITasksDesigner] fetchTasks error:', err);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchTasks();
    }, [fetchTasks]);

    // Load the user's own agents so a routine can be (re)assigned to one. Only
    // fetch when the beta is enabled — otherwise the selector stays hidden.
    useEffect(() => {
        if (!routinesAllowed) return;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/agents/all`);
                if (res.ok) setAgents(await res.json());
                else console.error('[AITasksDesigner] agents/all failed:', res.status);
            } catch (err) { console.error('[AITasksDesigner] agents/all error:', err); }
        })();
    }, [routinesAllowed]);

    const resetForm = () => {
        setTitle(''); setPrompt(''); setDate(''); setTime('');
        setRepeatInterval('weekly'); setTier('auto');
        setAgentId('');
        setEditingTaskId(null);
    };

    const startNewTask = () => {
        resetForm();
        setEditingTaskId('new');
    };

    const startEditTask = (task: PromptTask) => {
        setEditingTaskId(task.id);
        setTitle(task.title || '');
        setPrompt(task.prompt || '');
        if (task.nextRunAt) {
            const d = new Date(task.nextRunAt);
            setDate(d.toLocaleDateString('sv-SE'));
            setTime(d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
        } else {
            setDate(''); setTime('');
        }
        setRepeatInterval(task.repeatInterval || '');
        setTier(task.modelTier || 'auto');
        setAgentId(task.agentId || '');
    };

    const saveTask = async () => {
        if (!title.trim() || !prompt.trim() || !date || !time) return;
        const nextRunAt = new Date(`${date}T${time}`).toISOString();
        const body = {
            title: title.trim(),
            prompt: prompt.trim(),
            nextRunAt,
            repeatInterval: repeatInterval || null,
            modelTier: tier,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            ...(routinesAllowed ? { agentId: agentId || null } : {}),
        };
        try {
            const isNew = editingTaskId === 'new';
            const res = await authFetch(
                isNew ? `${API_BASE}/api/ai-tasks` : `${API_BASE}/api/ai-tasks/${editingTaskId}`,
                {
                    method: isNew ? 'POST' : 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }
            );
            if (res.ok) {
                await fetchTasks();
                resetForm();
            } else {
                const err: { error?: string } = await res.json().catch(() => ({}));
                toast.error(err.error || 'Failed to save task');
            }
        } catch (err) { console.error('Save AI task failed:', err); }
    };

    const toggleTask = async (id: string) => {
        try {
            const res = await authFetch(`${API_BASE}/api/ai-tasks/${id}/toggle`, { method: 'POST' });
            if (res.ok) fetchTasks();
        } catch (err) { console.error('Toggle AI task failed:', err); }
    };

    const requestDeleteTask = (task: PromptTask) => {
        setPendingDeleteTask(task);
    };

    const confirmDeleteTask = async () => {
        if (!pendingDeleteTask) return;
        try {
            await authFetch(`${API_BASE}/api/ai-tasks/${pendingDeleteTask.id}`, { method: 'DELETE' });
            setTasks(prev => prev.filter(t => t.id !== pendingDeleteTask.id));
            if (editingTaskId === pendingDeleteTask.id) resetForm();
            setPendingDeleteTask(null);
        } catch (err) { console.error('Delete AI task failed:', err); }
    };

    const runTaskNow = async (id: string) => {
        try {
            const res = await authFetch(`${API_BASE}/api/ai-tasks/${id}/run-now`, { method: 'POST' });
            if (res.ok) fetchTasks();
        } catch (err) { console.error('Run AI task failed:', err); }
    };

    const openInDirectChat = useCallback((title: string | undefined, content: string | undefined) => {
        setResultModal(null);
        window.dispatchEvent(new CustomEvent('openDirectChatWithContext', {
            detail: { title, content }
        }));
    }, []);

    const activeTasks = useMemo(() => tasks.filter(t => t.isActive), [tasks]);
    const inactiveTasks = useMemo(() => tasks.filter(t => !t.isActive), [tasks]);
    const editing = editingTaskId !== null;
    const isNewMode = editingTaskId === 'new';
    // Boolean, not the last truthy string: every caller uses it as one, and a
    // hook that hands out `''` where it says "can save" is one `{canSave}` in
    // JSX away from rendering it.
    const canSave = Boolean(title.trim() && prompt.trim() && date && time);

    const nextRunPreview = useMemo(() => {
        if (!date || !time) return null;
        try {
            return formatNextRun(new Date(`${date}T${time}`).toISOString());
        } catch {
            return null;
        }
    }, [date, time]);

    return {
        tasks,
        loading,
        maxTasks,
        agents,
        resultModal, setResultModal,
        pendingDeleteTask, setPendingDeleteTask,
        editingTaskId,
        title, setTitle,
        prompt, setPrompt,
        date, setDate,
        time, setTime,
        repeatInterval, setRepeatInterval,
        tier, setTier,
        agentId, setAgentId,
        activeTasks,
        inactiveTasks,
        editing,
        isNewMode,
        canSave,
        nextRunPreview,
        fetchTasks,
        resetForm,
        startNewTask,
        startEditTask,
        saveTask,
        toggleTask,
        requestDeleteTask,
        confirmDeleteTask,
        runTaskNow,
        openInDirectChat,
    };
}
