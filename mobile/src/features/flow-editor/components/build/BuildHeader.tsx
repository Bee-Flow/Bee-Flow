/**
 * The build screen's header — the web BuilderHeader for a phone, in one row:
 * Back, the routine's name (tap to rename) with its state and the autosave
 * under it ("Draft · Saved", "Live · v3 · Saved"), the one status action,
 * and ⋯. Saved changes that are not live yet, and Make vN live, are
 * PublishBanner's: the name keeps this row's room.
 *
 *   status action  Draft or Paused: "Go live", which validates the saved flow
 *                  at the strict stage first. Live: "Live", which asks before
 *                  switching the routine off. Neither while the AI builds or a
 *                  test runs, nor on a flow with no trigger or no steps (the
 *                  web's canActivate) — going live then would check a
 *                  half-built or empty flow.
 *   ⋯              everything else the web header offers: rename, findings,
 *                  run history, versions, flowlets, settings, details, and
 *                  for an app-event trigger Diagnose. Shown before the routine
 *                  exists too; what needs its id waits, disabled, until then.
 *
 * Ask AI, Steps | Canvas, undo, redo and the test runs are the toolbar's
 * (BuildToolbar): the name gets this row's room.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useActivateFlow, useDiagnoseTrigger, useDraftState } from '@/features/flow-editor/hooks';
import type { DraftStore } from '@/features/flow-editor/state';
import { useConfirm } from '@/shared/patterns';
import { ActionMenu, Button, Icon, IconButton, ObjectHeader, useToast, type ActionMenuItem } from '@/shared/ui';

import { DiagnoseSheet } from './DiagnoseSheet';
import { reportLiveRefusal } from './liveRefusal';
import { liveVersionWord, type LiveState } from './liveState';
import { saveWords } from './saveWords';

export interface BuildHeaderProps {
    flowKey: string;
    store: DraftStore;
    /** Null until a new routine has been created. */
    automationId: string | null;
    title: string;
    isActive: boolean;
    /** Never switched on (the web's Draft); off after having been on is Paused. */
    isDraft: boolean;
    /** Where the working copy stands against the live version; null on a server without the live split. */
    live?: LiveState | null;
    /** The primary trigger's kind: an app-event trigger can be diagnosed. */
    triggerKind?: string | null;
    /** A trigger and at least one step: something to switch on. */
    canActivate: boolean;
    /** The AI is building or a test is running: not the moment to go live. */
    busy: boolean;
    /** How many findings the routine has, for the ⋯ entry. */
    findings: number;
    onRename: () => void;
    /** Show the findings (and, after a refused Go live, what refused it). */
    onFindings: () => void;
    /** Open the routine's flowlets. */
    onFlowlets: () => void;
}

function stateWord(isActive: boolean, isDraft: boolean, t: TranslateFn): string {
    if (isActive) return t('mobile.flow.status_live', 'Live');
    return isDraft ? t('mobile.flow.status_draft', 'Draft') : t('routines.paused', 'Paused');
}

function useSubline(store: DraftStore, isActive: boolean, isDraft: boolean, live: LiveState | null): { text: string; error: boolean } {
    const t = useTranslation();
    const status = useDraftState(store, (s) => s.status);
    const saveError = useDraftState(store, (s) => s.saveError);
    const save = saveWords({ status, saveError }, t);
    const state = liveVersionWord(live, t) ?? stateWord(isActive, isDraft, t);
    return { text: save.text ? `${state} · ${save.error ? t('routines.header.save_failed', 'Not saved') : save.text}` : state, error: save.error };
}

/**
 * What Go live does, said when the server has the live split: a paused
 * routine switches its LIVE version back on (changes saved since stay
 * pending), a never-live one goes live with this version. The web's titles.
 */
function goLiveHint(live: LiveState | null | undefined, t: TranslateFn): string | undefined {
    if (live?.kind === 'paused') return t('routines.header.activate_paused_title', 'Switches the live version back on');
    if (live?.kind === 'never') return t('routines.header.activate_first_title', 'Goes live with this version and starts listening for its trigger');
    return undefined;
}

type StatusActionProps = Pick<BuildHeaderProps, 'flowKey' | 'isActive' | 'live' | 'canActivate' | 'busy' | 'onFindings'>;

function useStatusAction({ flowKey, isActive, live, canActivate, busy, onFindings }: StatusActionProps) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const activate = useActivateFlow(flowKey, {
        onSuccess: (_result, active) =>
            toast(active ? t('mobile.flow.live_now', 'Live — it runs on its trigger now') : t('mobile.flow.paused_now', 'Switched off'), 'success'),
        onError: (err) => reportLiveRefusal(err, toast, onFindings),
    });
    const switchOff = async () => {
        const ok = await confirm({
            title: t('mobile.flow.switch_off.title', 'Switch this routine off?'),
            message: t('mobile.flow.switch_off.message', 'It stops running on its trigger until you switch it on again.'),
            confirmLabel: t('mobile.flow.deactivate', 'Switch off'),
        });
        if (ok) activate.mutate(false);
    };
    if (isActive) {
        return (
            <Button
                size="sm"
                variant="success"
                iconName="CircleCheck"
                label={t('mobile.flow.status_live', 'Live')}
                accessibilityHint={t('mobile.flow.switch_off.hint', 'Asks before switching the routine off')}
                loading={activate.isPending}
                onPress={() => void switchOff()}
                testID="build-status-action"
            />
        );
    }
    return (
        <Button
            size="sm"
            variant="primary"
            label={t('mobile.flow.activate', 'Go live')}
            accessibilityHint={
                canActivate
                    ? goLiveHint(live, t)
                    : t('mobile.flow.activate_needs', 'Needs a trigger and at least one step first')
            }
            disabled={busy || !canActivate}
            loading={activate.isPending}
            onPress={() => activate.mutate(true)}
            testID="build-status-action"
        />
    );
}

export function BuildHeader(props: BuildHeaderProps) {
    const { flowKey, store, automationId, title, isActive, isDraft, live = null, triggerKind = null, findings, onRename, onFindings, onFlowlets } = props;
    const t = useTranslation();
    const router = useRouter();
    const [more, setMore] = useState(false);
    const [diagnosing, setDiagnosing] = useState(false);
    const diagnose = useDiagnoseTrigger(flowKey);
    const subline = useSubline(store, isActive, isDraft, live);
    const action = useStatusAction(props);
    const needsId = !automationId;
    // Each route written out whole: the route graph test reads them.
    const open = (to: (id: string) => string) => () => {
        if (automationId) router.push(to(automationId));
    };
    const waitHint = needsId ? t('mobile.flow.after_first_save', 'Available once the routine is saved') : undefined;
    const items: ActionMenuItem[] = [
        { id: 'rename', label: t('mobile.flow.rename', 'Rename'), icon: 'Pencil', onPress: onRename },
        ...(findings > 0
            ? [{ id: 'findings', label: t('mobile.flow.findings_count', 'Findings ({count})', { count: findings }), icon: 'TriangleAlert' as const, onPress: onFindings }]
            : []),
        { id: 'runs', label: t('routine_editor.run_history', 'Run history'), icon: 'Activity', disabled: needsId, accessibilityHint: waitHint, onPress: open((id) => `/automations/${id}/runs`) },
        { id: 'versions', label: t('routine_editor.version_history', 'Version history'), icon: 'History', disabled: needsId, accessibilityHint: waitHint, onPress: open((id) => `/automations/${id}/versions`) },
        { id: 'flowlets', label: t('routines.canvas.flowlets', 'Flowlets'), icon: 'Layers', onPress: onFlowlets },
        { id: 'settings', label: t('mobile.flow.settings.title', 'Settings'), icon: 'Settings', disabled: needsId, accessibilityHint: waitHint, onPress: open((id) => `/automations/${id}/settings`) },
        {
            id: 'details',
            label: t('mobile.flow.details', 'Details'),
            icon: 'Info',
            disabled: needsId,
            accessibilityHint: waitHint,
            onPress: open((id) => `/automations/${id}`),
        },
        ...(triggerKind === 'app_event'
            ? [{
                id: 'diagnose',
                label: t('mobile.flow.diagnose.action', 'Diagnose the trigger'),
                icon: 'Stethoscope' as const,
                accessibilityHint: t('routines.header.diagnose_title', 'Probe the trigger pipeline (subscription, credentials, Gmail, filter)'),
                onPress: () => {
                    setDiagnosing(true);
                    diagnose.mutate();
                },
            }]
            : []),
    ];
    return (
        <>
            <ObjectHeader
                kind="automation"
                tile={false}
                title={title}
                subtitle={subline.text}
                subtitleTone={subline.error ? 'error' : 'tertiary'}
                onTitlePress={onRename}
                titleHint={t('mobile.flow.rename_hint', 'Renames this routine')}
                primary={action}
                extras={<IconButton icon={<Icon name="Ellipsis" size={20} />} accessibilityLabel={t('mobile.flow.more', 'More')} onPress={() => setMore(true)} testID="build-more" />}
            />
            <ActionMenu visible={more} onClose={() => setMore(false)} title={title} items={items} />
            <DiagnoseSheet
                visible={diagnosing}
                onClose={() => setDiagnosing(false)}
                result={diagnose.data ?? null}
                loading={diagnose.isPending}
                error={diagnose.error}
            />
        </>
    );
}
