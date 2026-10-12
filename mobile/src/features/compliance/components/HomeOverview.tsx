/**
 * The "Overview" segment of the hub (web: mobile/MobileHomeOverview): the
 * framework scores, what needs attention, the running deadlines, and the
 * reports an auditor asks for. A list that has not loaded says so; one that
 * is empty says that — never a card that pretends "0".
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Badge, Banner, Button, Group, ListRow, NavRow, NoteRow, useToast } from '@/shared/ui';

import { shareDownload } from '../api/endpoints';
import type { AttentionItem, DeadlineItem } from '../api/readers';
import { useAttention, useDeadlines } from '../hooks/queries';
import { headlineOfScore, scoreOf, toneOfScore, type ComplianceCounts } from '../model/counts';
import { labelText } from '../model/fields';
import { attentionTarget, REPORTS, sectionRoute, targetRoute } from '../model/navigation';
import { sectionsInGroup, visibleSections } from '../model/sections';
import type { RecordTone } from '../model/types';

const MAX_DEADLINES = 10;

function attentionMeta(item: AttentionItem, t: TranslateFn): string | undefined {
    const parts = item.meta.frameworks.map((f) => [f.regulation, f.ref].filter(Boolean).join(' ')).filter(Boolean);
    if (item.severity) parts.push(t(`compliance.sev_${item.severity}`, item.severity));
    return parts.join(' · ') || undefined;
}

const STATE_TONE: Record<string, RecordTone> = { overdue: 'error', urgent: 'warning', ok: 'success' };

function stateLabel(state: string, t: TranslateFn): string {
    if (state === 'overdue') return t('compliance.dsr_state_overdue', 'Overdue');
    if (state === 'urgent') return t('compliance.dsr_state_urgent', 'Due soon');
    return t('compliance.dsr_state_ok', 'On track');
}

function FrameworkScores({ counts, enabled }: { counts: ComplianceCounts | undefined; enabled: ReadonlySet<string> }) {
    const t = useTranslation();
    const router = useRouter();
    const scored = new Set(Object.keys(counts?.scores ?? {}));
    const rows = visibleSections(sectionsInGroup('frameworks'), scored, enabled).filter((s) => s.view === 'checks');
    return (
        <Group title={t('compliance.rail_group_frameworks', 'Frameworks')}>
            {rows.map((s) => {
                const score = scoreOf(counts, s);
                return (
                    <NavRow
                        key={s.id}
                        testID={`framework-${s.id}`}
                        icon={s.icon}
                        label={labelText(s.label, t)}
                        description={headlineOfScore(score, t)}
                        trailing={score === null ? undefined : <Badge label={String(score)} tone={toneOfScore(score)} />}
                        onPress={() => router.push(sectionRoute(s.id))}
                    />
                );
            })}
        </Group>
    );
}

function AttentionGroup({ enabled }: { enabled: boolean }) {
    const t = useTranslation();
    const router = useRouter();
    const attention = useAttention(enabled);
    const items = attention.data?.items;
    let body: React.ReactNode;
    if (!items) {
        body = <NoteRow>{attention.isError ? t('compliance.mob_attention_failed', 'Could not load the open items.') : t('compliance.mob_loading', 'Loading…')}</NoteRow>;
    } else if (items.length === 0) {
        body = <NoteRow>{t('compliance.mob_attention_empty', 'Nothing needs attention right now.')}</NoteRow>;
    } else {
        body = items.map((item) => (
            <ListRow
                key={item.id}
                testID={`attention-${item.id}`}
                title={item.title}
                subtitle={attentionMeta(item, t)}
                trailing={<Badge label={t(`compliance.status_${item.status}`, item.status)} tone={item.status === 'fail' ? 'error' : 'warning'} />}
                chevron
                onPress={() => router.push(targetRoute(attentionTarget(item)))}
            />
        ));
    }
    return <Group title={t('compliance.mob_needs_attention', 'Needs attention')}>{body}</Group>;
}

/**
 * "CRA notification (72 h) · CRA Art. 14(2)(b)": the kind, then the article
 * as the server wrote it — a full citation ("GDPR Art. 33 · NIS2 Art. 23(4)"),
 * so it is never wrapped in another "Art.". An attestation's expiry has no
 * statutory clock and sends no article.
 */
function deadlineMeta(d: DeadlineItem, t: TranslateFn): string | undefined {
    const kind = d.kind ? t(`compliance.deadline_kind_${d.kind}`, d.kind) : null;
    return [kind, d.meta.article].filter(Boolean).join(' · ') || undefined;
}

function DeadlinesGroup({ enabled }: { enabled: boolean }) {
    const t = useTranslation();
    const router = useRouter();
    const deadlines = useDeadlines(enabled);
    const running = deadlines.data?.items.filter((d) => d.state !== 'done' && d.state !== 'none');
    let body: React.ReactNode;
    if (!running) {
        body = <NoteRow>{deadlines.isError ? t('compliance.mob_deadlines_failed', 'Could not load the deadlines.') : t('compliance.mob_loading', 'Loading…')}</NoteRow>;
    } else if (running.length === 0) {
        body = <NoteRow>{t('compliance.mob_deadlines_empty', 'No running deadlines.')}</NoteRow>;
    } else {
        body = running.slice(0, MAX_DEADLINES).map((d) => (
            <ListRow
                key={d.id}
                testID={`deadline-${d.id}`}
                title={[d.ref, d.title].filter(Boolean).join(' · ')}
                subtitle={deadlineMeta(d, t)}
                trailing={<Badge label={stateLabel(d.state, t)} tone={STATE_TONE[d.state] ?? 'neutral'} />}
                chevron={Boolean(d.target.section)}
                onPress={d.target.section ? () => router.push(targetRoute({ section: d.target.section ?? '', id: d.target.id })) : undefined}
            />
        ));
    }
    const title = running
        ? `${t('compliance.mob_deadlines', 'Deadlines')} · ${t('compliance.mob_deadlines_running', '{n} running', { n: running.length })}`
        : t('compliance.mob_deadlines', 'Deadlines');
    return <Group title={title}>{body}</Group>;
}

function ReportsGroup({ iso }: { iso: boolean }) {
    const t = useTranslation();
    const { toast } = useToast();
    const share = (report: (typeof REPORTS)[number]) =>
        shareDownload(report.download).catch((err: unknown) => toast(describeError(err).message, 'error'));
    return (
        <Group title={t('compliance.rail_reports_aria', 'Reports and downloads')} footer={t('compliance.ovw_reports_note', 'PDF and JSON only — a CSV of personal data is not an export this product offers.')}>
            {REPORTS.filter((r) => iso || !r.iso).map((report) => (
                <NavRow
                    key={report.id}
                    testID={`report-${report.id}`}
                    icon="FileDown"
                    label={labelText(report.label, t)}
                    description={labelText(report.description, t)}
                    onPress={() => void share(report)}
                />
            ))}
        </Group>
    );
}

export function HomeOverview({ counts, enabled }: { counts: ComplianceCounts | undefined; enabled: ReadonlySet<string> }) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <>
            {counts?.onboarded === false ? (
                <Banner
                    tone="info"
                    action={<Button size="sm" label={t('compliance.nav_settings', 'Settings')} onPress={() => router.push(sectionRoute('settings'))} />}
                >
                    {t('compliance.setup_lead', 'Pre-filled from your configuration — check it and adjust. The first scan runs straight after.')}
                </Banner>
            ) : null}
            <FrameworkScores counts={counts} enabled={enabled} />
            <AttentionGroup enabled />
            <DeadlinesGroup enabled />
            <ReportsGroup iso={enabled.has('iso27001') || counts?.scores.iso27001 !== undefined} />
        </>
    );
}
