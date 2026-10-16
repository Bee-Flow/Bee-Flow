import type { MutableRefObject } from 'react';
import type { AutomationBuilderSendOptions, AutomationBuilderState } from '../../../hooks/useAutomationBuilderStream';
import scopedStorage from '../../../utils/scopedStorage';
import { followUpPlanId } from './chat/planBuild';
import { isBlankDefinition, normalizeDefinitionShape } from './flow/normalizeDefinition';
import type { FlowDefinition } from './flow/types';

/** What one send reads from the shell render it was made in. */
export interface BuilderSendContext {
    readOnlyRef: MutableRefObject<boolean>;
    forceSaveNow: () => Promise<unknown> | void | null;
    state: AutomationBuilderState;
    serverAutomation: { id?: string | null } | null | undefined;
    effectiveDef: FlowDefinition | null | undefined;
    ensureAutomationCreated: (def: FlowDefinition | null | undefined) => Promise<string | null | undefined>;
    setError: (message: string | null) => void;
    workMode: string;
    alwaysPlanLarge: boolean | undefined;
    autoSendInput: unknown;
    forcedTier: string | null;
    tierForSend: string | undefined;
    assistantContext: { id?: string } | null | undefined;
    ndvStepId: string | null;
    scopeKey: string | null;
    seedMetadata: unknown;
    /** The definition the turn started from, for the undo checkpoint at its end. */
    turnBaseRef: MutableRefObject<unknown>;
    send: (options: AutomationBuilderSendOptions) => unknown;
}

export interface BuilderSendOptions {
    answers?: AutomationBuilderSendOptions['answers'];
    approvedPlanId?: string | null;
    pauseAfterStep?: boolean;
}

/**
 * The builder's send: save what is pending, make sure the automation exists,
 * then start the turn. InputArea calls it as onSendMessage(text, attachments,
 * parentId); webSearchEnabled / disabledMedia are read from scopedStorage so
 * the toggles in the input UI are picked up automatically. Pure: it closes over
 * the render it is built in, exactly as the inline arrow did.
 */
export function makeBuilderSend(c: BuilderSendContext) {
    return async (text: string, attachments?: unknown[], options: BuilderSendOptions = {}) => {
        if (c.readOnlyRef.current) return;
        try {
            const pendingSave = c.forceSaveNow();
            if (pendingSave) await pendingSave;
            const targetAutomationId = c.state.automationId || c.serverAutomation?.id || (!isBlankDefinition(c.effectiveDef) ? await c.ensureAutomationCreated(c.effectiveDef) : null);
            c.setError(null);
            const webSearchEnabled = scopedStorage.getItem('webSearchEnabled') !== 'false';
            const disabledMedia = scopedStorage.getJSON<Record<string, unknown>>('disabledMedia', {}) || {};
            // Until the approved plan is done every message continues it ("continue",
            // "fix X", the answer to a question the build asked); only then does the
            // user's own work mode apply to the next request again.
            const approvedPlanId = options.approvedPlanId || followUpPlanId({ plan: c.state.reviewPlan, questionsPlanId: c.state.reviewQuestionsPlanId, answering: !!options.answers });
            c.turnBaseRef.current = c.workMode === 'build' || approvedPlanId ? structuredClone(c.effectiveDef || normalizeDefinitionShape(null)) : null;
            c.send({
                message: text,
                // Set when the text answers the builder's questions: the chat shows
                // the structured list, the model gets the text.
                answers: options.answers || null,
                targetAutomationId,
                workMode: approvedPlanId ? 'plan' : c.workMode,
                approvedPlanId,
                alwaysPlanLarge: !!c.alwaysPlanLarge && !c.autoSendInput && !c.forcedTier,
                pauseAfterStep: options.pauseAfterStep ?? (!!approvedPlanId && !!c.state.reviewPlan?.pauseAfterStep),
                selectedStepId: c.assistantContext?.id || c.ndvStepId || null,
                modelTier: c.tierForSend,
                attachments: attachments || [],
                webSearchEnabled,
                disabledMedia,
                // Which canvas the user is looking at: lets the server hint
                // the model's default `scope` for builder tool calls.
                canvasScope: c.scopeKey,
                seedMetadata: c.seedMetadata || null,
            });
        } catch (error) {
            // A thrown string or number has no .message; fall back to its text.
            const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
            c.setError((typeof message === 'string' && message) || String(error));
        }
    };
}
