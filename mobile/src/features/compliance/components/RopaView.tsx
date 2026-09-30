/**
 * The processing register (web: pages/RopaPage): generated from the live
 * configuration, so the phone reads it and records the two human acts on it —
 * "reviewed" (Art. 30(4)) and the per-operator SCC attestation for a non-EU
 * processor — and hands out the PDF.
 *
 * Server: routes/compliance/ropa.js (GET /ropa, POST /ropa/review NoBody,
 * GET /ropa.pdf) and settings.js (POST /settings/scc `{ operator, confirmed }`).
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { ErrorState, Group, GroupedScroll, Icon, InfoRow, ListRow, LoadingState, NoteRow, SettingRow, ToggleRow, useToast } from '@/shared/ui';

import { shareDownload } from '../api/endpoints';
import { useReviewRopa, useSetScc } from '../hooks/mutations';
import { useRopa } from '../hooks/queries';
import { formatDate } from '../hooks/useFormatter';
import { COMPLIANCE } from '../model/paths';

const MAX_ROWS = 30;

export function RopaView() {
    const t = useTranslation();
    const { toast } = useToast();
    const ropa = useRopa(true);
    const review = useReviewRopa();
    const scc = useSetScc();
    const refresh = useUserRefresh(() => ropa.refetch());
    const fail = (err: unknown, fallback: string) => toast(describeError(err).message || fallback, 'error');

    if (ropa.isLoading) return <LoadingState />;
    if (ropa.isError || !ropa.data) return <ErrorState error={ropa.error} onRetry={() => void ropa.refetch()} />;
    const data = ropa.data;
    const reviewed = formatDate(data.last_reviewed_at);

    const onReview = () =>
        review.mutateAsync(undefined).then(
            () => toast(t('compliance.ropa_toast_reviewed', 'Processing register marked as reviewed'), 'success'),
            (err: unknown) => fail(err, t('compliance.ropa_toast_review_failed', 'Could not mark the register as reviewed')),
        );
    const onScc = (operator: string, confirmed: boolean) =>
        scc.mutateAsync({ operator, confirmed }).then(
            () => toast(confirmed ? t('compliance.scc_toast_confirmed', 'SCC attestation recorded') : t('compliance.scc_toast_revoked', 'SCC attestation withdrawn'), 'success'),
            (err: unknown) => fail(err, t('compliance.scc_toast_failed', 'Could not update the SCC attestation')),
        );

    return (
        <GroupedScroll refresh={refresh}>
            <Group title={t('compliance.ropa_title', 'Records of Processing Activities (Art. 30)')}>
                <NoteRow>
                    {reviewed
                        ? t('compliance.ropa_reviewed_at', 'Last reviewed {date}', { date: reviewed })
                        : t('compliance.ropa_never_reviewed', 'Never reviewed — check the generated record below and mark it as reviewed.')}
                </NoteRow>
                <SettingRow testID="ropa-review" label={t('compliance.ropa_mark_reviewed', 'Mark as reviewed')} icon={<Icon name="CircleCheck" size={18} />} disabled={review.isPending} onPress={() => void onReview()} />
                <SettingRow
                    testID="ropa-pdf"
                    label={t('compliance.ropa_download_pdf', 'Download ROPA (PDF)')}
                    icon={<Icon name="FileDown" size={18} />}
                    onPress={() => void shareDownload({ path: `${COMPLIANCE}/ropa.pdf`, fileName: 'ropa.pdf', mimeType: 'application/pdf' }).catch((err: unknown) => fail(err, ''))}
                />
            </Group>
            <Group title={t('compliance.ropa_controller', 'Controller')}>
                {data.controller.name ? <InfoRow label={t('compliance.ropa_org', 'Organisation')} value={data.controller.name} /> : null}
                {data.controller.dpo_name ? <InfoRow label={t('compliance.dpo_name', 'DPO name')} value={data.controller.dpo_name} /> : null}
                {data.legal_bases.length ? <InfoRow label={t('compliance.settings_legal_bases', 'Legal bases')} value={data.legal_bases.map((b) => t(`compliance.lb_${b}`, b)).join(', ')} /> : null}
            </Group>
            <Group title={`${t('compliance.ropa_activities', 'Processing activities')} · ${data.activities.length}`}>
                {data.activities.length === 0 ? <NoteRow>{t('compliance.ropa_no_activities', 'No published agents — no processing activities to record yet.')}</NoteRow> : null}
                {data.activities.slice(0, MAX_ROWS).map((a, i) => (
                    <ListRow key={a.activity_id ?? String(i)} title={a.name} subtitle={a.purpose ?? undefined} />
                ))}
            </Group>
            <Group title={t('compliance.ropa_processors', 'Processors')}>
                {data.processors.length === 0 ? <NoteRow>{t('compliance.ropa_no_processors', 'No outbound integration traffic observed.')}</NoteRow> : null}
                {data.processors.slice(0, MAX_ROWS).map((p) =>
                    p.is_eu ? (
                        <InfoRow key={p.operator} label={p.operator} value={t('compliance.ropa_scc_not_needed', 'EU — not required')} />
                    ) : (
                        <ToggleRow
                            key={p.operator}
                            testID={`scc-${p.operator}`}
                            label={p.operator}
                            description={[p.country_code, t('compliance.ropa_col_scc', 'SCC / DPA')].filter(Boolean).join(' · ')}
                            value={p.scc_confirmed}
                            disabled={scc.isPending}
                            onValueChange={(next) => void onScc(p.operator, next)}
                        />
                    ),
                )}
            </Group>
        </GroupedScroll>
    );
}
