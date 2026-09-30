/**
 * One check (web: framework/CheckRow + CheckExpansion): its latest result and
 * what it means, how to fix it, a re-run and — when the check has one — the
 * automatic fix, then its status history and hashed evidence rows.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, Group, GroupedScroll, Icon, InfoRow, ListRow, LoadingState, NoteRow, SettingRow, useToast } from '@/shared/ui';

import { ComplianceFrame } from './ComplianceFrame';
import type { CheckRow } from '../api/readers';
import { useAutoFixCheck, useRerunCheck } from '../hooks/mutations';
import { useCheckEvidence, useCheckHistory, useChecks } from '../hooks/queries';
import type { ComplianceGate } from '../hooks/useComplianceAccess';
import { formatDate } from '../hooks/useFormatter';
import { checkMeta, checkTitle, findCheck } from '../model/checks';
import { CHECK_STATUSES } from '../model/choices';
import { choiceOf, labelText } from '../model/fields';

const MAX_ROWS = 20;

function Actions({ check }: { check: CheckRow }) {
    const t = useTranslation();
    const { toast } = useToast();
    const rerun = useRerunCheck();
    const autoFix = useAutoFixCheck();
    const busy = rerun.isPending || autoFix.isPending;
    const go = async (fn: () => Promise<unknown>, ok: string, failed: string) => {
        try {
            await fn();
            toast(ok, 'success');
        } catch (err) {
            toast(describeError(err).message || failed, 'error');
        }
    };
    return (
        <Group title={t('common.actions', 'Actions')}>
            <SettingRow
                testID="check-rerun"
                label={t('mobile.compliance.rerun', 'Run this check again')}
                icon={<Icon name="RefreshCw" size={18} />}
                disabled={busy}
                onPress={() => void go(() => rerun.mutateAsync(check.check_id), t('compliance.toast_check_rerun', 'Check re-run complete'), t('compliance.toast_check_failed', 'Could not re-run this check'))}
            />
            {check.autoFixId ? (
                <SettingRow
                    testID="check-autofix"
                    label={t('compliance.attention_action_auto_fix', 'Auto-fix')}
                    icon={<Icon name="Wand2" size={18} />}
                    disabled={busy}
                    onPress={() => void go(() => autoFix.mutateAsync(check.check_id), t('compliance.toast_auto_fixed', 'Automatic fix applied'), t('compliance.toast_auto_fix_failed', 'Automatic fix failed — see server logs'))}
                />
            ) : null}
        </Group>
    );
}

function Trail({ check }: { check: CheckRow }) {
    const t = useTranslation();
    const history = useCheckHistory(check.check_id, true);
    const evidence = useCheckEvidence(check.check_id, true);
    const statusLabel = (s: string) => {
        const c = choiceOf(CHECK_STATUSES, s);
        return c ? labelText(c.label, t) : s;
    };
    return (
        <>
            <Group title={t('mobile.compliance.check_history', 'History')}>
                {(history.data ?? []).length === 0 ? <NoteRow>{t('compliance.custom_history_empty', 'Nothing recorded yet.')}</NoteRow> : null}
                {(history.data ?? []).slice(0, MAX_ROWS).map((h, i) => (
                    <ListRow key={`${h.run_at ?? ''}-${i}`} title={statusLabel(h.status)} subtitle={[formatDate(h.run_at), h.details].filter(Boolean).join(' · ') || undefined} />
                ))}
            </Group>
            <Group title={t('compliance.custom_attest_evidence', 'Evidence')}>
                {(evidence.data ?? []).length === 0 ? <NoteRow>{t('compliance.custom_history_empty', 'Nothing recorded yet.')}</NoteRow> : null}
                {(evidence.data ?? []).slice(0, MAX_ROWS).map((e) => (
                    <ListRow key={e.id} title={e.hash ? `sha256 ${e.hash.slice(0, 16)}…` : e.id} subtitle={formatDate(e.captured_at) ?? undefined} />
                ))}
            </Group>
        </>
    );
}

function CheckBody({ check }: { check: CheckRow }) {
    const t = useTranslation();
    const status = choiceOf(CHECK_STATUSES, check.status);
    const description = check.description ?? (check.descriptionKey ? t(check.descriptionKey, '') : '');
    const remediation = check.remediationKey ? t(check.remediationKey, '') : '';
    return (
        <>
            <Group>
                {status ? <InfoRow label={t('common.status', 'Status')} value={labelText(status.label, t)} tone={status.tone === 'error' || status.tone === 'warning' || status.tone === 'success' ? status.tone : 'primary'} /> : null}
                {checkMeta(check, t) ? <InfoRow label={check.check_id} value={checkMeta(check, t) ?? ''} /> : null}
                {check.run_at ? <InfoRow label={t('mobile.compliance.last_run', 'Last run')} value={formatDate(check.run_at) ?? ''} /> : null}
            </Group>
            {check.details ? <Group title={t('compliance.inc_f_desc', 'Details')}><NoteRow>{check.details}</NoteRow></Group> : null}
            {description ? <Group><NoteRow>{description}</NoteRow></Group> : null}
            {remediation ? <Group title={t('compliance.attention_action_open_fix', 'Open fix')}><NoteRow>{remediation}</NoteRow></Group> : null}
        </>
    );
}

export function CheckDetail({ framework, id, gate }: { framework: string; id: string; gate: ComplianceGate }) {
    const t = useTranslation();
    const checks = useChecks(framework, gate.open);
    const refresh = useUserRefresh(() => checks.refetch());
    const check = findCheck(checks.data, id);
    let body: React.ReactNode;
    if (checks.isLoading) body = <LoadingState />;
    else if (checks.isError) body = <ErrorState error={checks.error} onRetry={() => void checks.refetch()} />;
    else if (!check) body = <EmptyState icon="ListChecks" title={t('mobile.compliance.not_found', 'This record is no longer in the register.')} />;
    else {
        body = (
            <GroupedScroll refresh={refresh}>
                <CheckBody check={check} />
                <Actions check={check} />
                <Trail check={check} />
            </GroupedScroll>
        );
    }
    return (
        <ComplianceFrame title={check ? checkTitle(check, t) : id} subtitle={check?.regulation ?? undefined} gate={gate}>
            {body}
        </ComplianceFrame>
    );
}
