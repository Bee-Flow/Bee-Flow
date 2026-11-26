import { useState } from 'react';
import { useCoworkConversation, useCoworkProposals, useCoworkProposalActions, type CoworkMessage } from '@/api/coworkProposals';
import type { CoworkItem } from '@/api/cowork.types';
import type { PlanState } from '@/api/coworkPlan.types';
import { useCoworkItemActions } from '@/api/coworkTask';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { OrbView } from './CoworkTaskOrb';

interface Options {
    item: CoworkItem; plan?: PlanState; view: OrbView | 'settings'; live: boolean;
    select: (view: OrbView) => void; rebuild: () => void; t: TranslateFn;
}

export default function useTaskConversation({ item, plan, view, live, select, rebuild, t }: Options) {
    const [text, setText] = useState('');
    const [history, setHistory] = useState<CoworkMessage[]>([]);
    const [reply, setReply] = useState('');
    const [selection, setSelection] = useState<{ fingerprint?: string; ids: string[] }>({ ids: [] });
    const [pendingBrief, setPendingBrief] = useState<{ prompt: string; fingerprint?: string } | null>(null);
    const dialog = useCoworkConversation(item.id);
    const edit = useCoworkProposalActions(item.id);
    const update = useCoworkItemActions(item.id).change;
    const proposals = useCoworkProposals(item.id);
    const proposal = proposals.data?.find(p => p.status === 'open' && p.reasonCode === 'owner_request');
    const fingerprint = plan?.draft?.fingerprint;
    const selected = selection.fingerprint === fingerprint ? selection.ids : [];
    const toggle = (id: string) => {
        setSelection({ fingerprint, ids: selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id] });
        setReply('');
    };
    const scope = fingerprint && selected.length ? { stepIds: selected, fingerprint } : undefined;
    const busy = edit.requestChange.isPending || edit.approve.isPending || edit.dismiss.isPending || update.isPending;
    const change = (instruction: string) => {
        select('overview');
        if (live || busy) return setReply(t('cowork_task.orb.wait_edit', 'I can change the steps when the current work finishes.'));
        if (proposal) return setReply(t('cowork_task.orb.review', 'Apply this tested change?'));
        if (plan?.upToDate) {
            setReply('');
            edit.requestChange.mutate({ instruction, scope });
        } else {
            const steps = plan?.draft?.view.steps.filter(s => selected.includes(s.id)) ?? [];
            const context = steps.map(s => s.title + ' [' + s.id + ']').join(', ');
            setPendingBrief({ prompt: [item.prompt, context, instruction].filter(Boolean).join('\n\n'), fingerprint });
        }
    };
    const send = () => {
        const message = text.trim();
        if (!message || dialog.isPending || selected.length > 100) return;
        setText('');
        setReply('');
        dialog.mutate({ message, view, scope, history: history.slice(-6) }, {
            onSuccess: answer => {
                setHistory(prev => [...prev, { role: 'user', text: message }, { role: 'assistant', text: answer.answer }].slice(-6) as CoworkMessage[]);
                setReply(answer.answer);
                if (answer.action === 'change') change(answer.instruction);
                else if (answer.action !== 'answer') select(answer.action);
            },
            onError: () => setText(current => current || message),
        });
    };
    const saveBrief = () => {
        if (!pendingBrief || live || busy || pendingBrief.fingerprint !== fingerprint) return;
        update.mutate({ prompt: pendingBrief.prompt }, { onSuccess: () => {
            setPendingBrief(null);
            setReply(t('cowork_task.edit.saved', 'Saved'));
            if (plan?.draft) rebuild();
        } });
    };
    const error = [dialog, edit.requestChange, edit.approve, edit.dismiss, update, proposals].find(operation => operation.error)?.error;
    return { text, setText, reply, setReply, send, selected, toggle, dialog, edit, busy, proposal, error,
        pendingBrief: pendingBrief?.fingerprint === fingerprint ? pendingBrief : null, saveBrief, cancel: () => setPendingBrief(null) };
}
export type TaskConversation = ReturnType<typeof useTaskConversation>;
