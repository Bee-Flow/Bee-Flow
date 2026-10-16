import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useCmsRedirectActions, useCmsRedirects } from '../../../../api/queries/cmsRedirects';
import type { CmsRedirect } from '../../../../api/queries/cmsRedirects';

const inputClass = 'w-full px-2 py-1 rounded text-xs font-mono border bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-[var(--border-default)] focus:outline-none focus:border-[var(--accent-primary)]';
const labelClass = 'text-[10px] text-[var(--text-muted)]';
const buttonClass = 'px-2.5 py-1 rounded text-xs font-medium bg-[var(--accent-primary)] text-white disabled:opacity-50';

type Actions = ReturnType<typeof useCmsRedirectActions>;

function AddForm({ actions }: { actions: Actions }) {
    const { t } = useTranslation();
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [status, setStatus] = useState<301 | 302>(301);
    const [external, setExternal] = useState(false);
    const ready = from.trim() !== '' && to.trim() !== '';

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!ready) return;
        actions.add.mutate(
            { from: from.trim(), to: to.trim(), status, external },
            { onSuccess: () => { setFrom(''); setTo(''); setExternal(false); } },
        );
    };

    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label className="flex flex-col gap-0.5">
                <span className={labelClass}>{t('cms_redirects.from_label', 'Old address')}</span>
                <input className={inputClass} value={from} onChange={e => setFrom(e.target.value)} spellCheck={false} placeholder={t('cms_redirects.from_placeholder', '/old-page')} />
            </label>
            <label className="flex flex-col gap-0.5">
                <span className={labelClass}>{t('cms_redirects.to_label', 'New address')}</span>
                <input className={inputClass} value={to} onChange={e => setTo(e.target.value)} spellCheck={false} placeholder={t('cms_redirects.to_placeholder', '/new-page')} />
            </label>
            <label className="flex flex-col gap-0.5">
                <span className={labelClass}>{t('cms_redirects.status_label', 'Type')}</span>
                <select className={inputClass} value={status} onChange={e => setStatus(e.target.value === '302' ? 302 : 301)}>
                    <option value={301}>{t('cms_redirects.status_301', 'Permanent (301)')}</option>
                    <option value={302}>{t('cms_redirects.status_302', 'Temporary (302)')}</option>
                </select>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                <input type="checkbox" checked={external} onChange={e => setExternal(e.target.checked)} />
                {t('cms_redirects.external_label', 'The new address is on another website')}
            </label>
            <div>
                <button type="submit" className={buttonClass} disabled={actions.add.isPending || !ready}>
                    {t('cms_redirects.add', 'Add redirect')}
                </button>
            </div>
        </form>
    );
}

function RedirectList({ rows, loaded, actions }: { rows: CmsRedirect[]; loaded: boolean; actions: Actions }) {
    const { t } = useTranslation();
    return (
        <ul className="flex flex-col gap-1">
            {loaded && rows.length === 0 && (
                <li className="text-[11px] text-[var(--text-muted)]">{t('cms_redirects.empty', 'No redirects yet.')}</li>
            )}
            {rows.map(row => (
                <li key={row.id} className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--bg-tertiary)] text-xs">
                    <span className="font-mono truncate min-w-0 flex-1" title={`${row.from} → ${row.to}`}>
                        {row.from} → {row.to}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0">{row.status}</span>
                    {row.auto && (
                        <span className="text-[10px] px-1 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] shrink-0">
                            {t('cms_redirects.auto_badge', 'Automatic')}
                        </span>
                    )}
                    <button
                        type="button"
                        className="text-[var(--text-muted)] hover:text-red-400 shrink-0"
                        disabled={actions.remove.isPending}
                        aria-label={t('cms_redirects.remove', 'Remove the redirect from {from}', { from: row.from })}
                        onClick={() => actions.remove.mutate(row.id)}
                    >
                        ×
                    </button>
                </li>
            ))}
        </ul>
    );
}

function AllowedHosts({ hosts, actions }: { hosts: string[]; actions: Actions }) {
    const { t } = useTranslation();
    const [text, setText] = useState(hosts.join('\n'));
    useEffect(() => { setText(hosts.join('\n')); }, [hosts]);
    const save = () => actions.saveHosts.mutate(text.split(/[\s,]+/).map(h => h.trim()).filter(Boolean));
    return (
        <div className="flex flex-col gap-1">
            <label htmlFor="cms-redirect-hosts" className="text-xs font-semibold">{t('cms_redirects.hosts_title', 'Allowed websites')}</label>
            <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                {t('cms_redirects.hosts_help', 'A redirect to another website only works for the websites listed here (one per line, for example example.com).')}
            </p>
            <textarea id="cms-redirect-hosts" className={`${inputClass} h-20`} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
            <div>
                <button type="button" className={buttonClass} disabled={actions.saveHosts.isPending} onClick={save}>
                    {t('cms_redirects.hosts_save', 'Save list')}
                </button>
            </div>
        </div>
    );
}

interface RedirectsInspectorProps {
    siteId: string | null;
    /** Called after a successful write: the public site changes at the next publish. */
    onSaved?: () => void;
}

/**
 * Redirects of the site: the `__redirects__` navigator entry. A renamed page
 * adds its own 301; this list is for the rest (merged pages, old campaign
 * addresses) and for removing what is no longer needed. The server refuses
 * loops and unsafe targets, and says why.
 */
export default function RedirectsInspector({ siteId, onSaved }: RedirectsInspectorProps) {
    const { t } = useTranslation();
    const query = useCmsRedirects(siteId);
    const actions = useCmsRedirectActions(siteId, onSaved);
    const failure = actions.add.error || actions.remove.error || actions.saveHosts.error;
    const error = failure
        ? (failure.message || t('cms_redirects.error_generic', 'Could not save the redirect.'))
        : (query.isError ? t('cms_redirects.load_error', 'Could not load the redirects.') : null);

    return (
        <div className="h-full overflow-y-auto p-3 flex flex-col gap-4 text-[var(--text-primary)]">
            <div>
                <h3 className="text-sm font-semibold">{t('cms_redirects.title', 'Redirects')}</h3>
                <p className="text-[11px] leading-snug text-[var(--text-muted)] mt-1">
                    {t('cms_redirects.intro', 'Send visitors and search engines from an old address to a new one. Renaming a page adds a permanent redirect by itself. Changes go live when you publish.')}
                </p>
            </div>
            {error && <p role="alert" className="text-[11px] leading-tight text-red-400">{error}</p>}
            <AddForm actions={actions} />
            <RedirectList rows={query.data?.redirects ?? []} loaded={!!query.data} actions={actions} />
            <AllowedHosts hosts={query.data?.allowedHosts ?? []} actions={actions} />
        </div>
    );
}
