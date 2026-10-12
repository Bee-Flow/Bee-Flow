import { Ban, BadgeCheck, Globe, ListChecks, Loader2, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import ChoiceCards from '../../shared/ChoiceCards';
import toast from '../../shared/Toast';
import { useMcpPolicyQuery, useSaveMcpPolicy } from '../../../api/queries/mcpLibrary';
import type { RemoteMode } from '../../../api/queries/mcpLibrary';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorText, policyDescription, policyLabel } from '../libraryText';
import { ALERT_ERROR, CARD, DASHED, EYEBROW, HINT, INPUT, PRIMARY_BTN, SECONDARY_BTN } from '../ui';

const parseHosts = (text: string) => text.split(/[\s,]+/).map(h => h.trim()).filter(Boolean);

/**
 * What organisation admins may install, for the whole server. The server
 * re-checks it on every tool call, so tightening it also stops what is
 * already installed (those servers are kept, not deleted).
 */
export default function PolicyCard() {
    const { t } = useTranslation();
    const query = useMcpPolicyQuery();
    const save = useSaveMcpPolicy();
    const hostsId = useId();
    const [mode, setMode] = useState<RemoteMode | null>(null);
    const [hostsText, setHostsText] = useState<string | null>(null);

    if (query.isLoading) {
        return <div className={`${CARD} h-40 animate-pulse`} role="status"><span className="sr-only">{t('mcp_library.loading', 'Loading the MCP library…')}</span></div>;
    }
    if (query.isError || !query.data) {
        return (
            <div role="alert" className={DASHED}>
                <p className="m-0 text-[12px] text-[var(--text-secondary)]">{errorText(t, query.error)}</p>
                <button type="button" className={SECONDARY_BTN} onClick={() => query.refetch()}>{t('mcp_library.retry', 'Try again')}</button>
            </div>
        );
    }

    const stored = query.data.policy;
    const current = mode ?? stored.remote;
    const hosts = hostsText ?? stored.allowedHosts.join('\n');
    const dirty = current !== stored.remote || (current === 'allowlist' && parseHosts(hosts).join('\n') !== stored.allowedHosts.join('\n'));
    const icon = { off: Ban, official: BadgeCheck, allowlist: ListChecks, any: Globe } as const;

    const submit = () => save.mutate(
        { remote: current, allowedHosts: current === 'allowlist' ? parseHosts(hosts) : stored.allowedHosts },
        { onSuccess: () => { setMode(null); setHostsText(null); toast.success(t('mcp_library.policy.saved', 'Policy saved')); } },
    );

    return (
        <section className={CARD} aria-labelledby={`${hostsId}-title`}>
            <div className="flex items-start gap-3">
                <span className="w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]">
                    <ShieldCheck size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                    <h3 id={`${hostsId}-title`} className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t('mcp_library.policy.title', 'What organisation admins may install')}</h3>
                    <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">
                        {t('mcp_library.policy.intro', 'Organisation libraries only ever connect to remote servers over https; they never run code on this server and can never reach a private network. This decides which remote servers.')}
                    </p>
                </div>
            </div>

            <ChoiceCards
                value={current}
                onChange={setMode}
                ariaLabel={t('mcp_library.policy.title', 'What organisation admins may install')}
                columns={2}
                appearance="radio"
                disabled={save.isPending}
                options={query.data.modes.map(m => ({
                    value: m,
                    label: policyLabel(t, m),
                    description: policyDescription(t, m),
                    Icon: icon[m],
                    badge: m === 'official' ? t('mcp_library.policy.recommended', 'Recommended') : undefined,
                }))}
            />

            {current === 'allowlist' && (
                <div>
                    <label htmlFor={hostsId} className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">{t('mcp_library.policy.hosts', 'Allowed hosts')}</label>
                    <textarea
                        id={hostsId}
                        rows={4}
                        className={`${INPUT} font-mono resize-y`}
                        value={hosts}
                        onChange={e => setHostsText(e.target.value)}
                        placeholder={t('mcp_library.policy.hosts_example', 'mcp.example.com\n*.internal-tools.example.com')}
                        spellCheck={false}
                    />
                    <p className={HINT}>{t('mcp_library.policy.hosts_hint', 'One host per line. *.example.com allows every subdomain. No https://, ports or paths.')}</p>
                </div>
            )}

            <div>
                <h4 className={EYEBROW}>{t('mcp_library.policy.official_hosts', 'Official endpoints')}</h4>
                <p className="m-0 mt-1 text-[11.5px] leading-relaxed font-mono text-[var(--text-tertiary)] break-words">{query.data.officialHosts.join(' · ')}</p>
            </div>

            {save.isError && <div role="alert" className={ALERT_ERROR}>{errorText(t, save.error)}</div>}
            {dirty && (
                <div className="flex gap-2">
                    <button type="button" className={PRIMARY_BTN} onClick={submit} disabled={save.isPending}>
                        {save.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                        {t('mcp_library.policy.save', 'Save policy')}
                    </button>
                    <button type="button" className={SECONDARY_BTN} onClick={() => { setMode(null); setHostsText(null); }} disabled={save.isPending}>
                        {t('mcp_library.drawer.cancel', 'Cancel')}
                    </button>
                </div>
            )}
        </section>
    );
}
