import { useCallback, useState } from 'react';
import { describeSchedule } from '../components/cowork/coworkSchedule';
import useCoworkComposer from '../components/cowork/useCoworkComposer';
import { toast } from '../components/shared/Toast';

interface CreatedCowork {
    title?: string;
    nextRunAt?: string | null;
    repeatInterval?: string | null;
}

/**
 * ── Chat ⇄ Cowork ───────────────────────────────────────────────────
 * The composer can either talk to you (chat) or go do something (cowork).
 * One composer state for the whole hub, so flipping the switch in the
 * welcome composer and in the docked one is the same flip.
 */
export default function useComposerMode() {
    const [coworkMode, setCoworkMode] = useState<string>('chat');
    // In Cowork the composer produces a scheduled run, not a conversation, so
    // the chat-side panels have nothing to attach to: a Notebook and a Webpage
    // are things you read ALONGSIDE a conversation you are having.
    const inCoworkMode = coworkMode === 'cowork';
    const coworkComposer = useCoworkComposer({
        onCreated: (created: CreatedCowork | null | undefined) => {
            // Say what it understood, not just that it worked: the schedule was
            // read out of the user's own sentence, so it has to be visible and
            // correctable rather than silently assumed.
            const schedule = describeSchedule({
                presetId: 'custom',
                runAt: created?.nextRunAt,
                repeatInterval: created?.repeatInterval,
            });
            toast.success(`"${created?.title || 'Untitled cowork'}" scheduled — ${schedule}. Change it under Cowork in the sidebar.`);
        },
    // The untyped JS hook's inferred options name only `enabled`; the cast
    // restores `onCreated`, which it does read.
    } as Parameters<typeof useCoworkComposer>[0]);
    // Agent chat defaults the work to that agent: if you're mid-conversation
    // with an agent and delegate something, you mean that agent to do it.
    // Only seed an agent the picker actually offers — outside the
    // agent_routines beta the create call would 403 on the agentId.
    const coworkAgentIds = coworkComposer.agents;
    const setCoworkAgentId = coworkComposer.setAgentId;
    const setCoworkModeForAgent = useCallback((mode: string, agentId?: string | null) => {
        setCoworkMode(mode);
        if (mode === 'cowork' && agentId && coworkAgentIds.some((a: { id: string }) => a.id === agentId)) {
            setCoworkAgentId(agentId);
        }
    }, [coworkAgentIds, setCoworkAgentId]);

    return { coworkMode, setCoworkMode, inCoworkMode, coworkComposer, setCoworkModeForAgent };
}
