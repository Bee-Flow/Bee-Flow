import { CircleCheck, CircleX, Info, Loader2, RefreshCw, type LucideIcon } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { N8nDiagnostics, TestResult } from './n8nModel';

/** The live connection pill above the tabs. */
export function StatusPill({ configured, testResult }: { configured: boolean; testResult: TestResult | null }) {
    const { t } = useTranslation();
    let label: string, bg: string, color: string, Icon: LucideIcon;
    if (testResult?.ok) {
        const count = testResult.activeWebhookCount;
        label = count == null
            ? t('settings.connected', 'Connected')
            : count === 1
                ? t('settings.n8n.status_connected_one', 'Connected · 1 active webhook workflow')
                : t('settings.n8n.status_connected_many', 'Connected · {count} active webhook workflows', { count });
        bg = 'rgba(16,185,129,0.12)'; color = '#10b981'; Icon = CircleCheck;
    } else if (testResult && !testResult.ok) {
        label = `${t('settings.n8n.status_failed', 'Connection failed')}${testResult.error ? ` — ${String(testResult.error).slice(0, 80)}` : ''}`;
        bg = 'rgba(239,68,68,0.12)'; color = '#ef4444'; Icon = CircleX;
    } else if (configured) {
        label = t('settings.n8n.status_configured', 'Configured — click Test to verify');
        bg = 'var(--bg-tertiary)'; color = 'var(--text-secondary)'; Icon = Info;
    } else {
        label = t('settings.n8n.status_not_configured', 'Not configured');
        bg = 'var(--bg-tertiary)'; color = 'var(--text-muted)'; Icon = Info;
    }
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full" style={{ background: bg, color }}>
            <Icon className="w-3 h-3" /> {label}
        </span>
    );
}

interface CheckRow {
    label: string;
    ok: boolean;
    fix?: { label: string; action: () => void; disabled?: boolean } | null;
    detail?: string | null;
}

interface AccessCheckProps {
    diag: N8nDiagnostics | null;
    loading: boolean;
    onRefresh: () => void;
    onEnableForOrg: () => void;
    enablingForOrg: boolean;
    onGotoPermissions: () => void;
}

type Detail = Record<string, (t: TranslateFn) => string>;
const ORG_SOURCE_DETAIL: Detail = {
    all_enabled: (t) => t('settings.n8n.src_all_enabled', 'No restriction — implicit.'),
    org_override: (t) => t('settings.n8n.src_org_override', 'Org-level override in use.'),
    global_default: (t) => t('settings.n8n.src_global_default', 'Following global default.'),
};
const USER_REASON_DETAIL: Detail = {
    auto_enabled: (t) => t('settings.n8n.user_auto_enabled', 'Auto-enabled for new integrations.'),
    in_saved_list: (t) => t('settings.n8n.user_in_saved_list', 'You have n8n in your Apps list.'),
    no_saved_list: (t) => t('settings.n8n.user_no_saved_list', 'All apps enabled by default.'),
};
const detailFrom = (t: TranslateFn, table: Detail, key: string | undefined) => {
    const entry = key && Object.hasOwn(table, key) ? table[key] : undefined;
    return entry ? entry(t) : null;
};

/** The four checks behind "can the AI see and change n8n workflows". */
function checkRows(t: TranslateFn, diag: N8nDiagnostics, p: AccessCheckProps): CheckRow[] {
    const enabled = !!diag.org?.enabledIntegrationsIncludesN8n;
    const canModify = !!diag.permissions?.modify_n8n_workflows;
    return [
        {
            label: t('settings.n8n.row_credentials', 'n8n credentials stored for this organisation'),
            ok: !!diag.org?.n8nConfigured,
            fix: null, // happens on the same tab — just scroll to form
        },
        {
            label: t('settings.n8n.row_enabled', 'n8n is enabled in the organisation\'s integration set'),
            ok: enabled,
            fix: enabled ? null : {
                label: p.enablingForOrg ? t('settings.n8n.enabling', 'Enabling…') : t('settings.n8n.enable_for_org', 'Enable for organisation'),
                action: p.onEnableForOrg,
                disabled: p.enablingForOrg,
            },
            detail: detailFrom(t, ORG_SOURCE_DETAIL, diag.org?.source),
        },
        {
            label: t('settings.n8n.row_user_can_use', 'Your account can use n8n (read/run tools)'),
            ok: !!diag.userLevel?.passes,
            detail: detailFrom(t, USER_REASON_DETAIL, diag.userLevel?.reason),
        },
        {
            label: t('settings.n8n.row_user_can_modify', 'Your account can modify workflows (create/edit/delete/execute)'),
            ok: canModify,
            fix: canModify ? null : { label: t('settings.n8n.manage_permissions', 'Manage permissions'), action: p.onGotoPermissions },
            detail: canModify
                ? t('settings.n8n.granted_via', 'Granted via orgRole or group permission.')
                : t('settings.n8n.ask_admin_grant', 'Ask an admin to grant the "Modify n8n Workflows" permission.'),
        },
    ];
}

const Mark = ({ ok, className }: { ok: boolean; className: string }) => (ok
    ? <CircleCheck className={className} style={{ color: '#10b981' }} />
    : <CircleX className={className} style={{ color: '#ef4444' }} />);

/**
 * Renders /ai/n8n/diagnostics as a short, actionable checklist so the admin
 * can tell at a glance why the AI can or can't see their n8n workflows.
 */
export function AccessCheckCard(p: AccessCheckProps) {
    const { t } = useTranslation();
    const { diag, loading, onRefresh } = p;
    if (loading && !diag) {
        return (
            <div className="rounded-lg border px-3 py-3 flex items-center gap-2 text-[11px] border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('settings.n8n.checking_access', 'Checking access…')}
            </div>
        );
    }
    if (!diag) return null;
    const rows = checkRows(t, diag, p);
    const allPass = rows.every(r => r.ok);
    const toolCount = (diag.toolsThatWillBeInjected || []).length;
    const seen = toolCount === 1 ? t('settings.n8n.ai_sees_one', 'AI sees 1 n8n tool') : t('settings.n8n.ai_sees_many', 'AI sees {count} n8n tools', { count: toolCount });
    return (
        <div className="rounded-lg border overflow-hidden border-[var(--border-subtle)]">
            <div className="px-3 py-2.5 flex items-center justify-between gap-2 [background:var(--bg-secondary)] [border-bottom:1px_solid_var(--border-subtle)]">
                <div className="flex items-center gap-1.5">
                    <Mark ok={allPass} className="w-3.5 h-3.5" />
                    <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {t('settings.n8n.access_check', 'Access check')}
                    </span>
                    <span className="text-[11px] ml-1 text-[var(--text-muted)]">
                        {allPass ? seen : t('settings.n8n.ai_cannot_see', 'AI can\'t see n8n workflows')}
                    </span>
                </div>
                <button onClick={onRefresh} disabled={loading}
                    className="text-[11px] px-2 py-0.5 rounded flex items-center gap-1 disabled:opacity-50 text-[var(--text-secondary)]" title={t('settings.n8n.refresh', 'Refresh')}>
                    <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>
            <ul className="divide-y border-[var(--border-subtle)]">
                {rows.map((r, i) => (
                    <li key={i} className="px-3 py-2 flex items-start gap-2.5">
                        <Mark ok={r.ok} className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="text-xs text-[var(--text-primary)]">{r.label}</div>
                            {r.detail && <div className="text-[11px] mt-0.5 text-[var(--text-muted)]">{r.detail}</div>}
                        </div>
                        {r.fix && (
                            <button
                                onClick={r.fix.action}
                                disabled={r.fix.disabled}
                                className="text-[11px] font-medium px-2 py-0.5 rounded border shrink-0 disabled:opacity-50 border-[var(--border-default)] text-[var(--accent-primary)]"
                            >
                                {r.fix.label}
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {allPass && toolCount > 0 && (
                <details className="text-[11px] px-3 py-2 border-t border-[var(--border-subtle)] text-[var(--text-muted)]">
                    <summary className="cursor-pointer">{t('settings.n8n.show_tool_list', 'Show tool list')}</summary>
                    <code className="block mt-1 font-mono text-[10.5px] break-all text-[var(--text-secondary)]">
                        {(diag.toolsThatWillBeInjected || []).join(', ')}
                    </code>
                </details>
            )}
        </div>
    );
}
