import useOrbDestinations from './useOrbDestinations';
import useConversationClock from './useConversationClock';
import { useState } from 'react';
import { useCoworkConversation, useCoworkProposals, useCoworkProposalActions, type CoworkMessage, type CoworkReply } from '@/api/coworkProposals';
import type { CoworkItem } from '@/api/cowork.types';
import type { PlanState } from '@/api/coworkPlan.types';
import { useCoworkItemActions } from '@/api/coworkTask';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { OrbView } from './CoworkTaskOrb';

interface Options {
    item: CoworkItem; plan?: PlanState; view: OrbView | 'settings'; live: boolean;
    openTask: (id: string, shared?: boolean) => void; select: (view: OrbView | 'share') => void; rebuild: () => void; t: TranslateFn;
}

export default function useTaskConversation({ item, plan, view, live, select, openTask, rebuild, t }: Options) {
    const [text, setText] = useState('');
    const [history, setHistory] = useState<CoworkMessage[]>([]);
    const destinations = useOrbDestinations(select, openTask, t);
    const [reply, setReply] = useState('');
    const [selection, setSelection] = useState<{ fingerprint?: string; ids: string[] }>({ ids: [] });
    const [pendingBrief, setPendingBrief] = useState<{ prompt: string; fingerprint?: string } | null>(null);
    const dialog = useCoworkConversation(item.id);
    const edit = useCoworkProposalActions(item.id);
    const update = useCoworkItemActions(item.id).change;
    const clock = useConversationClock(item, live, update, setReply, t);
    const proposals = useCoworkProposals(item.id);
    const proposal = proposals.data?.find(p => p.status === 'open' && p.reasonCode === 'owner_request');
    const fingerprint = plan?.draft?.fingerprint;
    const selected = selection.fingerprint === fingerprint ? selection.ids : [];
    const toggle = (id: string) => {
        destinations.clear();
        setSelection({ fingerprint, ids: selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id] });
        setReply('');
    };
    const scope = fingerprint && selected.length ? { stepIds: selected, fingerprint } : undefined;
    const busy = edit.requestChange.isPending || edit.approve.isPending || edit.dismiss.isPending || update.isPending;
    const change = (instruction: string, remove?: CoworkReply['remove']) => {
        select('overview');
        if (live || busy) return setReply(t('cowork_task.orb.wait_edit', 'I can change the steps when the current work finishes.'));
        if (proposal) return setReply(t('cowork_task.orb.review', 'Apply this tested change?'));
        if (remove && remove.fingerprint !== fingerprint) return setReply(t('cowork_task.orb.steps_changed', 'The steps changed. Select them again.'));
        if (plan?.upToDate) {
            setReply('');
            edit.requestChange.mutate(remove ? {remove} : { instruction, scope }, {
                onError: err => setHistory(prev => [...prev.slice(-5), {role: 'assistant', text: err.message.slice(0, 2000)}]),
            });
        } else {
            const steps = plan?.draft?.view.steps.filter(s => selected.includes(s.id)) ?? [];
            const context = steps.map(s => s.title + ' [' + s.id + ']').join(', ');
            setPendingBrief({ prompt: [item.prompt, context, instruction].filter(Boolean).join('\n\n'), fingerprint });
        }
    };
    const send = (messageOverride?: string) => {
        const message = (messageOverride ?? text).trim();
        if (!message || dialog.isPending || selected.length > 100) return;
        clock.cancel();
        destinations.clear();
        setText('');
        setReply('');
        dialog.mutate({ message, view, scope, history: history.slice(-6) }, {
            onSuccess: answer => {
                const shown = destinations.receive(answer);
                const context = answer.tasks?.length ? [shown, ...answer.tasks.map(task => task.title)].join('\n').slice(0, 2000) : shown;
                setHistory(prev => [...prev, { role: 'user', text: message }, { role: 'assistant', text: context }].slice(-6) as CoworkMessage[]);
                setReply(shown);
                if (answer.action === 'when' && answer.schedule) clock.propose(answer.schedule);
                else if (answer.action === 'change') change(answer.instruction, answer.remove);
                else if (answer.action !== 'answer') select(answer.action);
            },
            onError: () => setText(current => current || message),
        });
    };
    const askRecipient = () => {
        const question = t('cowork_task.orb.ask_recipient', 'Who should receive the result?');
        setSelection({ ids: [] });
        setReply(question);
        setHistory(prev => [...prev.slice(-5), { role: 'assistant', text: question }]);
        select('overview');
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
    return { destinations, resume: () => update.mutate({isActive: true}), clock, text, setText, reply, setReply, send, askRecipient, selected, toggle, dialog, edit, busy, proposal, error,
        pendingBrief: pendingBrief?.fingerprint === fingerprint ? pendingBrief : null, saveBrief, cancel: () => setPendingBrief(null) };
}
export type TaskConversation = ReturnType<typeof useTaskConversation>;
