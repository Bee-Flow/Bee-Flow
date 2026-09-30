/**
 * The access phase: WHO may use the app the playbook built. Where it stands
 * now, a plan (said in a sentence or chosen by hand), and a gate that lists
 * every change before Approve makes one. Approving applies the people and
 * the audience (publishing takes a copy of the app as it stands), then lands
 * the phase with the web's summary line.
 *
 * A plan that creates roles, row rules or a role per group needs the app's
 * whole data model rewritten, which the phone does not hold (see
 * model/accessApply.ts): that plan is approved in App Studio on a computer,
 * and the gate says so. It does not offer the web page: on a phone the web
 * sends Studio back to the chat, after a sign-in the in-app browser does not
 * share with this app.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

import { AccessPlanBox, EMPTY_PLAN } from './AccessPlanBox';
import { StageCard } from './StageCard';
import { useApplyAccess } from '../hooks/mutations';
import { useAppAccess } from '../hooks/queries';
import { accessSummary, needsModelWrite } from '../model/accessApply';
import { currentAccess, plannedChanges, whyDisabled } from '../model/accessView';
import { artStr } from '../model/artifacts';
import type { PlaybookEvent } from '../model/phaseMachine';
import type { AccessPlan, AppAccess, Phase, Playbook } from '../model/types';

interface Props {
    playbook: Playbook;
    phase: Phase;
    dispatch: (e: PlaybookEvent) => Promise<Playbook | null>;
}

function Gate({ plan, app, onApprove, applying }: { plan: AccessPlan; app: unknown; onApprove: () => void; applying: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const changes = plannedChanges(plan, { app }, t);
    const blocked = whyDisabled(plan, t);
    const onComputerOnly = !plan.empty && needsModelWrite(plan);
    return (
        <View style={styles.gate} testID="playbook-access-gate">
            {changes.map((c, i) => (
                <Text key={i} variant="caption" tone={c.kind === 'note' ? 'tertiary' : 'primary'}>
                    {`• ${c.words}`}
                </Text>
            ))}
            {onComputerOnly ? (
                <Banner tone="info">
                    {t('mobile.playbooks.access.computer_only', 'This plan creates roles for the app. Roles are part of the app’s data model, which is changed in App Studio on a computer — approve this plan there, or change it here so it creates none.')}
                </Banner>
            ) : null}
            {blocked ? (
                <Text variant="caption" tone="secondary">
                    {blocked}
                </Text>
            ) : null}
            <Button label={t('mobile.playbooks.access.approve', 'Approve and apply')} iconName="ShieldCheck" loading={applying} disabled={!!blocked || onComputerOnly} onPress={onApprove} testID="playbook-access-approve" />
        </View>
    );
}

/** The plan, the gate and what went wrong applying it — only while the phase is being decided. */
function Deciding({ playbook, phase, dispatch, app }: Props & { app: AppAccess | null }) {
    const t = useTranslation();
    const appId = artStr(phase.artifacts, 'appId') ?? '';
    const apply = useApplyAccess(appId);
    const [plan, setPlan] = useState<AccessPlan>(EMPTY_PLAN);
    const [problem, setProblem] = useState<string | null>(null);
    const approve = async () => {
        setProblem(null);
        const out = await apply.mutateAsync(plan);
        if (out.failed.length) {
            setProblem(out.failed.map((f) => `${f.what}: ${describeError(f.error).message}`).join('\n'));
            return;
        }
        await dispatch({ type: 'finished', key: phase.key, summary: accessSummary(plan, t), artifacts: { appId, accessApplied: true, nextcloudMenu: false } });
    };
    return (
        <>
            <AccessPlanBox playbookId={playbook.id} phaseKey={phase.key} plan={plan} onPlan={setPlan} />
            <Gate plan={plan} app={app} applying={apply.isPending} onApprove={() => void approve()} />
            {problem ? <Banner tone="error">{problem}</Banner> : null}
        </>
    );
}

/** The stage's one status line: the failure, or where the app stands now. */
function standing(phase: Phase, access: ReturnType<typeof useAppAccess>['data'], t: ReturnType<typeof useTranslation>): string {
    if (phase.status === 'failed') return phase.error || t('playbooks.access.failed', 'This phase did not land — try it again.');
    const now = currentAccess(access?.app ?? null, access?.members ?? 0, t);
    return `${now.who} · ${now.namedLine}`;
}

export function AccessStage({ playbook, phase, dispatch }: Props) {
    const t = useTranslation();
    const appId = artStr(phase.artifacts, 'appId');
    const access = useAppAccess(appId);
    const app = access.data?.app ?? null;
    if (!appId) {
        return <StageCard kind="app" title={t('playbooks.phase.access', 'Access')} status={t('playbooks.access.no_app', 'There is no app to give access to.')} tone="error" />;
    }
    const failed = phase.status === 'failed';
    const landed = phase.status === 'awaiting' || phase.status === 'done';
    return (
        <StageCard
            kind="app"
            title={t('playbooks.access.title', 'Who uses "{name}"?', { name: app?.name || playbook.title })}
            subtitle={t('playbooks.access.intro', 'Say it in a sentence or set it yourself. Nothing is applied until you approve it.')}
            status={standing(phase, access.data, t)}
            tone={failed ? 'error' : 'quiet'}
            testID="playbook-stage-access"
        >
            {landed && phase.summary ? (
                <Text variant="caption" tone="secondary">
                    {phase.summary}
                </Text>
            ) : null}
            {phase.status === 'running' && !phase.optimistic ? <Deciding playbook={playbook} phase={phase} dispatch={dispatch} app={app} /> : null}
        </StageCard>
    );
}

const makeStyles = (theme: Theme) => ({
    gate: {
        gap: theme.spacing[2],
        paddingTop: theme.spacing[2],
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderDefault,
    },
});
