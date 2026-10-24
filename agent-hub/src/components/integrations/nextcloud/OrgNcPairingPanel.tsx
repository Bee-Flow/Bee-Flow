import { Copy, Check, RefreshCw, Trash2, ServerCog } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import useConfirm from '../../shared/useConfirm';
import { useTranslation } from '../../../hooks/useTranslation';
import { messageOf } from '../../../utils/caughtError';
import { logger } from '../../../utils/logger';
import { mutate, ApiError } from '../../../api/mutate';

interface PairingCode {
    id: string;
    code: string;
    expiresAt?: string;
}

/**
 * "Pair a new Nextcloud" admin panel.
 *
 * Use case: a customer already has a Bee Flow org (subscription + users +
 * knowledge base), and they install Bee Flow on a brand-new Nextcloud
 * instance — different `instanceId`, different admin email. Without a
 * deliberate pairing step, the connector would auto-create a second org
 * and the customer ends up with two split-brain Bee Flows.
 *
 * Flow:
 *   - Click "Generate pairing code" → SaaS mints an 8-char human-readable
 *     code (15-min TTL) and shows it here.
 *   - Admin sets it on the new NC connector as BEEFLOW_PAIRING_CODE
 *     (via `occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE <code>`)
 *     and reinstalls the app.
 *   - Connector includes the code as `X-Beeflow-Pairing-Code` header on
 *     its bootstrap call; SaaS validates + binds + returns the tenantKey
 *     for THIS existing org. No fresh-org creation, no separate approval —
 *     the code IS the approval.
 *
 * Codes are one-shot and disappear from this list as soon as redeemed.
 */
const OrgNcPairingPanel = () => {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [codes, setCodes] = useState<PairingCode[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [justCopiedId, setJustCopiedId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await authFetch(`${API_BASE}/auth/admin/nc-bindings/pairing-codes`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setCodes(data.codes || []);
        } catch (e) {
            setError(messageOf(e, 'Failed to load pairing codes'));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    const generate = async () => {
        setGenerating(true);
        setError(null);
        try {
            const res = await authFetch(`${API_BASE}/auth/admin/nc-bindings/generate-pairing-code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            await reload();
        } catch (e) {
            setError(messageOf(e, 'Failed to generate pairing code'));
        } finally {
            setGenerating(false);
        }
    };

    const revoke = async (id: string) => {
        if (!(await confirm({ title: 'Revoke this pairing code?', description: 'Anyone who has it will no longer be able to use it.', confirmLabel: 'Revoke', destructive: true }))) return;
        try {
            try {
                await mutate(`${API_BASE}/auth/admin/nc-bindings/pairing-codes/${id}`, { method: 'DELETE' });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error(`HTTP ${err.status}`);
            }
            await reload();
        } catch (e) {
            setError(messageOf(e, 'Failed to revoke'));
        }
    };

    const copy = async (id: string, code: string) => {
        try {
            await navigator.clipboard.writeText(code);
            setJustCopiedId(id);
            setTimeout(() => setJustCopiedId((curr: string | null) => curr === id ? null : curr), 1500);
        } catch (err) { logger.debug('clipboard denied — ignore', err); }
    };

    const fmtCountdown = (expiresAt: string | undefined) => {
        if (!expiresAt) return '';
        const ms = new Date(expiresAt).getTime() - Date.now();
        if (ms <= 0) return 'expired';
        const min = Math.floor(ms / 60_000);
        const sec = Math.floor((ms % 60_000) / 1000);
        return `${min}m ${sec.toString().padStart(2, '0')}s remaining`;
    };

    return (
        <div className="rounded-xl p-5 mb-4 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
            <div className="flex items-start gap-3 mb-4">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]">
                    <ServerCog className="w-5 h-5 text-[var(--warning-ink)]" />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-[14px] font-semibold mb-1 text-[var(--text-primary)]">
                        {t('integ.org_nc_pairing_pair_a_new_nextcloud', 'Pair a new Nextcloud')}
                    </h3>
                    <p className="text-[12px] leading-snug text-[var(--text-muted)]">
                        {t('integ.org_nc_pairing_generate_a_one_shot_code_then_set_it', 'Generate a one-shot code, then set it as the')} <code className="px-1.5 py-0.5 rounded text-[11px] bg-[var(--bg-tertiary)]">BEEFLOW_PAIRING_CODE</code> {t('integ.org_nc_pairing_environment_variable_on_the_connector', 'environment variable on the connector running on the new Nextcloud. The code binds that Nextcloud to this same Bee Flow organisation instead of creating a new one.')}
                    </p>
                </div>
            </div>

            {error && (
                <div className="mb-3 px-3 py-2 rounded-lg text-[12px] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error-ink)]" role="alert">
                    {error}
                </div>
            )}

            <div className="flex items-center gap-2 mb-3">
                <button
                    onClick={generate}
                    disabled={generating}
                    className="px-3.5 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-40 bg-[var(--accent-primary)]"
                >
                    {generating ? 'Generating…' : 'Generate pairing code'}
                </button>
                <button
                    onClick={reload}
                    disabled={loading}
                    className="px-2.5 py-2 rounded-lg text-[12px] flex items-center gap-1.5 disabled:opacity-40 bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    title={t('integ.org_nc_pairing_refresh', 'Refresh')}
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {codes.length === 0 ? (
                <p className="text-[12px] text-[var(--text-tertiary)]">
                    {t('integ.org_nc_pairing_no_active_pairing_codes_generated', 'No active pairing codes. Generated codes live for 15 minutes and disappear after use.')}
                </p>
            ) : (
                <ul className="space-y-2">
                    {codes.map((c: PairingCode) => (
                        <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                            <code className="text-[15px] font-mono font-semibold tracking-wider text-[var(--text-primary)]">
                                {c.code}
                            </code>
                            <span className="text-[11px] flex-1 text-[var(--text-tertiary)]">
                                {fmtCountdown(c.expiresAt)}
                            </span>
                            <button
                                onClick={() => copy(c.id, c.code)}
                                className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ color: justCopiedId === c.id ? '#10b981' : 'var(--text-muted)' }}
                                title={justCopiedId === c.id ? 'Copied!' : 'Copy'}
                            >
                                {justCopiedId === c.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                            <button
                                onClick={() => revoke(c.id)}
                                className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                                title={t('integ.org_nc_pairing_revoke', 'Revoke')}
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <details className="mt-4 text-[12px]">
                <summary className="cursor-pointer font-medium text-[var(--text-secondary)]">
                    {t('integ.org_nc_pairing_how_to_use_this_code_on_the_new', 'How to use this code on the new Nextcloud')}
                </summary>
                <div className="mt-2 pl-3 space-y-1.5 text-[var(--text-muted)]">
                    <p>{t('integ.org_nc_pairing_on_the_new_nextcloud_server_run', 'On the new Nextcloud server, run:')}</p>
                    <pre className="px-3 py-2 rounded-lg overflow-x-auto text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
{`occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE <CODE>
occ app_api:app:disable bee_flow
occ app_api:app:enable bee_flow`}
                    </pre>
                    <p>{t('integ.org_nc_pairing_the_connector_picks_up_the_code_on', 'The connector picks up the code on next boot, redeems it once, and binds this Nextcloud to your existing Bee Flow organisation.')}</p>
                </div>
            </details>
            {confirmDialog}
        </div>
    );
};

export default OrgNcPairingPanel;
