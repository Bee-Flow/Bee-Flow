/**
 * Saving an existing agent from the manual editor — the web's
 * agentSaveApi.saveAgent outcomes, as a phone reads them:
 *
 *   200  adopt the server's echo as the new baseline
 *   409  someone saved in between: "Keep mine" re-sends against the server's
 *        rev; otherwise the screen offers "Load latest" and keeps the edits
 *        until the person picks it (the web's conflict modal)
 *   403  `agent_not_editable`: stop, say so, lock the editor — a retry
 *        would be refused the same way
 *   else the server's own sentence (a 400 names the field it refused)
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useSaveAgent } from './editor';
import type { AgentForm } from './useAgentForm';
import { readAgentDetail } from '../api/editorReaders';
import { agentKeys } from '../api/keys';
import { draftOf, type AgentDetail } from '../model/draft';

export interface EditorSave {
    save: () => Promise<boolean>;
    saving: boolean;
    /** The last refusal, in the server's words. */
    error: string | null;
    /** The copy another save left on the server, while the person decides. */
    conflict: AgentDetail | null;
    loadLatest: () => void;
    locked: boolean;
}

function conflictOf(e: unknown): { rev?: number; agent: AgentDetail | null } | null {
    if (!(e instanceof ApiError) || e.status !== 409) return null;
    const body = (e.body ?? {}) as { currentVersion?: unknown; agent?: unknown };
    return {
        rev: typeof body.currentVersion === 'number' ? body.currentVersion : undefined,
        agent: body.agent && typeof body.agent === 'object' ? readAgentDetail(body.agent) : null,
    };
}

export function useEditorSave(agent: AgentDetail, form: AgentForm): EditorSave {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const mutation = useSaveAgent(agent.id);
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState<AgentDetail | null>(null);
    const [locked, setLocked] = useState(false);

    const keepMine = () =>
        confirm({
            title: t('agent_wizard.conflict.title', 'This agent changed elsewhere'),
            message: t('agent_wizard.conflict.overwrite_hint', 'Keep mine — overwrite with your version.'),
            confirmLabel: t('agent_wizard.conflict.overwrite', 'Keep mine'),
        });

    const send = async (rev: number | undefined): Promise<boolean> => {
        try {
            const saved = await mutation.mutateAsync({ draft: form.draft, rev });
            form.reset(draftOf(saved));
            setError(null);
            setConflict(null);
            toast(t('agent_wizard.builder.save_saved', 'Saved'), 'success');
            return true;
        } catch (e) {
            const clash = conflictOf(e);
            if (clash) {
                if (await keepMine()) return send(clash.rev);
                setConflict(clash.agent ?? agent);
                return false;
            }
            if (e instanceof ApiError && e.code === 'agent_not_editable') setLocked(true);
            setError(describeError(e).message);
            return false;
        }
    };

    return {
        save: () => (form.check() ? send(agent.rev) : Promise.resolve(false)),
        saving: mutation.isPending,
        error,
        conflict,
        loadLatest: () => {
            // The server's copy becomes the baseline AND the rev the next save is checked against.
            if (conflict) {
                queryClient.setQueryData(agentKeys.draft(agent.id), conflict);
                form.reset(draftOf(conflict));
            }
            setConflict(null);
        },
        locked,
    };
}
