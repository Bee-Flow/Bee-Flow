// Spend → Other services: the AI services billed outside the model table
// (document intelligence, content safety, PII detection, embeddings), which
// only exist on Azure deployments.

import { Binary, FileText, ScanEye, Server, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { fInt, fMoney } from '../adoption/format';
import { fNum } from '../format';
import type { AzureServiceType, AzureTypeRow } from '../OverviewTab.types';
import type { SpendViewProps } from './spend.types';
import { CARD } from './tableStyle';

type T = ReturnType<typeof useTranslation>['t'];

interface ServiceInfo { label: string; icon: LucideIcon; metric: string }

function serviceInfo(svc: AzureTypeRow, showTokens: boolean, t: T): ServiceInfo {
    const kinds: Record<AzureServiceType, ServiceInfo> = {
        doc_intelligence: { label: t('usage.azure_doc_intelligence', 'Document Intelligence'), icon: FileText, metric: t('usage.spend_pages', '{n} pages', { n: fNum(svc.total_pages) }) },
        content_safety: { label: t('usage.azure_content_safety', 'Content Safety'), icon: ShieldCheck, metric: t('usage.spend_chars', '{n} chars', { n: fNum(svc.total_chars) }) },
        pii_detection: { label: t('usage.azure_pii_detection', 'PII Detection'), icon: ScanEye, metric: t('usage.spend_chars', '{n} chars', { n: fNum(svc.total_chars) }) },
        embedding: { label: t('usage.azure_embeddings', 'Embeddings'), icon: Binary, metric: showTokens ? t('usage.ov_tokens', '{n} tokens', { n: fNum(svc.total_tokens) }) : '' },
    };
    return kinds[svc.service_type] ?? { label: svc.service_type, icon: Server, metric: '' };
}

export function OtherServicesPanel({ azureServices, currency, showTokens }: Pick<SpendViewProps, 'azureServices' | 'currency' | 'showTokens'>) {
    const { t } = useTranslation();
    const byType = (azureServices.byType || []) as AzureTypeRow[];
    const total = (azureServices.summary as { total_cost?: number } | null)?.total_cost;
    if (byType.length === 0) {
        return (
            <section className={`${CARD} px-6 py-5`}>
                <h3 className="m-0 mb-1.5 text-[15px] font-semibold text-[var(--text-primary)]">{t('usage.spend_other_ai', 'Other AI services')}</h3>
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">
                    {t('usage.spend_other_empty', 'Document intelligence, content safety, PII detection and embeddings are billed outside the model table. Nothing was used in this period.')}
                </p>
            </section>
        );
    }
    return (
        <section aria-label={t('usage.azure_services', 'Azure Services')} className={`${CARD} overflow-hidden`}>
            <ul className="m-0 grid list-none p-0 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                {byType.map((svc) => {
                    const info = serviceInfo(svc, showTokens, t);
                    const Icon = info.icon;
                    return (
                        <li key={svc.service_type} className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-3.5 py-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent-primary)]"><Icon className="h-4 w-4" aria-hidden="true" /></span>
                            <div className="min-w-0 flex-1">
                                <div className="text-xs font-semibold text-[var(--text-primary)]">{info.label}</div>
                                <div className="mt-px text-[11px] text-[var(--text-muted)]">{fInt(svc.calls)} {t('usage.calls')}{info.metric ? ` · ${info.metric}` : ''}</div>
                            </div>
                            <div className="shrink-0 text-sm font-bold tabular-nums text-[var(--text-primary)]">{fMoney(svc.total_cost, currency)}</div>
                        </li>
                    );
                })}
            </ul>
            <div className="flex items-center justify-between border-t-2 border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3.5 py-2.5">
                <span className="text-[11px] font-bold uppercase tracking-[.05em] text-[var(--text-muted)]">{t('usage.total', 'Total')}</span>
                <span className="text-base font-bold tabular-nums text-[var(--text-primary)]">{fMoney(total, currency)}</span>
            </div>
        </section>
    );
}
