import React, { useEffect, useState } from 'react';
import { useSupportSlaPoliciesQuery } from '@/api/queries/supportPanels';
import { Save } from 'lucide-react';
import { API_BASE } from '@/utils/helpers';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { RefusedError, mutate, errorBody } from '@/api/mutate';

interface SlaPolicy {
    priority: string;
    first_response_minutes?: number | null;
    resolution_minutes?: number | null;
    enabled?: boolean | null;
}

interface SlaDefaults {
    first: number;
    resolution: number;
}

interface SlaRowProps {
    priority: string;
    row: Partial<SlaPolicy>;
    busy: boolean;
    defaults: SlaDefaults;
    onSave: (priority: string, firstMin: number, resMin: number, enabled: boolean) => void;
}

const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const DEFAULTS: Record<string, SlaDefaults> = {
    urgent: { first: 60, resolution: 240 },
    high: { first: 240, resolution: 1440 },
    normal: { first: 720, resolution: 2880 },
    low: { first: 1440, resolution: 5760 },
};

const NO_POLICIES: Record<string, SlaPolicy> = {};

export default function SupportSlaPoliciesTab() {
    const { t } = useTranslation();
    const [busy, setBusy] = useState<string | null>(null);
    const [actionError, setError] = useState<string | null | undefined>(null);

    const slaQuery = useSupportSlaPoliciesQuery<SlaPolicy>();
    const rows: Record<string, SlaPolicy> = slaQuery.data ?? NO_POLICIES;
    const load = async () => { await slaQuery.refetch(); };
    const error = actionError ?? (slaQuery.isError ? errorMessage(slaQuery.error) : null);

    const save = async (priority: string, firstMin: number, resMin: number, enabled: boolean) => {
        setBusy(priority);
        setError(null);
        try {
            try {
                await mutate(`${API_BASE}/api/support/sla-policies`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ priority, first_response_minutes: firstMin, resolution_minutes: resMin, enabled }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                throw new Error(e.error || 'Save failed');
            }
            await load();
        } catch (e) { setError(errorMessage(e)); }
        finally { setBusy(null); }
    };

    return (
        <div className="max-w-2xl mx-auto p-4">
            <h3 className="text-sm font-semibold mb-1 text-[var(--text-primary)]">{t('support.support_sla_policies_sla_policies', 'SLA policies')}</h3>
            <p className="text-xs mb-4 text-[var(--text-muted)]">
                {t('support.support_sla_policies_first_response_and_resolution_targets', 'First-response and resolution targets per priority (in minutes). Threads that breach are flagged and the assignee is notified. The clock pauses while a thread is waiting on the customer.')}
            </p>
            {error && <div className="text-xs mb-3 px-3 py-2 rounded [background:rgba(220,38,38,0.08)] [color:#dc2626]!">{error}</div>}
            <div className="space-y-2">
                {PRIORITIES.map((p: string) => {
                    const row = rows[p] || {};
                    return (
                        <SlaRow key={p} priority={p} row={row} busy={busy === p} defaults={DEFAULTS[p]} onSave={save} />
                    );
                })}
            </div>
        </div>
    );
}

function SlaRow({ priority, row, busy, defaults, onSave }: SlaRowProps) {
    const { t } = useTranslation();
    const [first, setFirst] = useState(row.first_response_minutes ?? defaults.first);
    const [res, setRes] = useState(row.resolution_minutes ?? defaults.resolution);
    const [enabled, setEnabled] = useState(row.enabled !== false);
    const [prevRowDeps, setPrevRowDeps] = useState([row, defaults]);
    if (prevRowDeps[0] !== row || prevRowDeps[1] !== defaults) {
        setPrevRowDeps([row, defaults]);
        setFirst(row.first_response_minutes ?? defaults.first);
        setRes(row.resolution_minutes ?? defaults.resolution);
        setEnabled(row.enabled !== false);
    }

    return (
        <div className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)]">
            <span className="w-20 text-sm font-medium capitalize text-[var(--text-primary)]">{priority}</span>
            <label className="text-xs flex items-center gap-1 text-[var(--text-muted)]">
                {t('support.support_sla_policies_first', 'First')} <input type="number" min="1" value={first} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFirst(parseInt(e.target.value, 10) || 0)} className="w-20 px-2 py-1 rounded border [background:var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]" /> {t('support.support_sla_policies_min', 'min')}
            </label>
            <label className="text-xs flex items-center gap-1 text-[var(--text-muted)]">
                {t('support.support_sla_policies_resolve', 'Resolve')} <input type="number" min="1" value={res} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRes(parseInt(e.target.value, 10) || 0)} className="w-20 px-2 py-1 rounded border [background:var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]" /> {t('support.support_sla_policies_min', 'min')}
            </label>
            <label className="text-xs flex items-center gap-1 ml-auto text-[var(--text-secondary)]">
                <input type="checkbox" checked={enabled} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEnabled(e.target.checked)} /> {t('support.support_sla_policies_on', 'on')}
            </label>
            <button onClick={() => onSave(priority, first, res, enabled)} disabled={busy}
                className="px-2.5 py-1 rounded-md text-xs flex items-center gap-1 disabled:opacity-50 [background:var(--accent-primary)] [color:white]!">
                <Save className="w-3 h-3" /> {busy ? '…' : 'Save'}
            </button>
        </div>
    );
}
