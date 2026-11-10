import { Copy, Link2, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import toast from '@/components/shared/Toast';
import type { TranslateFn } from '@/hooks/useTranslation';
import { copyText } from '@/utils/copyText';
import { messageOf } from '@/utils/caughtError';
import { MAX_PUBLIC_URLS } from './publicPageModel';
import usePublicPages from './usePublicPages';
import type { PublicPageBlocker, PublicPageRow } from './usePublicPages';

/**
 * The app's live public URLs: create, copy, revoke. The routes are owner-only
 * and minting or revoking also needs the manage_apps permission; a refusal
 * shows the server's own sentence. A URL can exist before it opens: the
 * blockers say what still stands in the way.
 */

const BTN = 'inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-card-hover)] disabled:opacity-50 text-[var(--text-primary)]';

/** The server's reasons, in words that say what to do; `hasDraftBlock` replaces the saved-draft check. */
function blockerLines(t: TranslateFn, blockers: PublicPageBlocker[], hasDraftBlock: boolean): string[] {
    const lines: string[] = [];
    if (!hasDraftBlock) lines.push(t('studio_apps_public.blocker.no_public_access', 'Turn the public page on above: no screen is open to visitors yet.'));
    for (const b of blockers) {
        if (b.code === 'not_published') lines.push(t('studio_apps_public.blocker.not_published', 'The app is not published. Choose who can open it on the Audience tab and press Apply: visitors are always served the published copy.'));
        else if (b.code === 'not_in_published') lines.push(t('studio_apps_public.blocker.not_in_published', 'The published copy has no public page yet. Press Apply to publish again.'));
        else if (b.code === 'surface_unresolved') lines.push(t('studio_apps_public.blocker.surface_unresolved', 'The published public page does not lead to a screen. Press Apply to publish again.'));
    }
    return lines;
}

export default function PublicPageUrls({ t, appId, hasDraftBlock }: { t: TranslateFn; appId: string; hasDraftBlock: boolean }) {
    const { query, create, revoke } = usePublicPages(appId);
    const [confirming, setConfirming] = useState<string | null>(null);
    if (query.isLoading) return <p className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('studio_apps_public.urls.loading', 'Loading the public URLs…')}</p>;
    if (query.isError) return <p className="text-xs [color:#b45309]">{messageOf(query.error, t('studio_apps_public.urls.load_failed', 'The public URLs could not be loaded.'))}</p>;
    const state = query.data;
    if (!state || state.forbidden) return <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_public.urls.owner_only', 'Only the owner of the app can create or revoke its public URLs.')}</p>;

    const full = state.pages.length >= MAX_PUBLIC_URLS;
    const doCreate = () => create.mutate(undefined, {
        onError: (err) => toast.error(messageOf(err, t('studio_apps_public.urls.create_failed', 'The URL could not be created.'))),
    });
    const doRevoke = (token: string) => revoke.mutate(token, {
        onSuccess: () => setConfirming(null),
        onError: (err) => toast.error(messageOf(err, t('studio_apps_public.urls.revoke_failed', 'The URL could not be revoked.'))),
    });
    const lines = blockerLines(t, state.blockers, hasDraftBlock);
    return (
        <div className="space-y-2" data-testid="public-page-urls">
            {lines.length ? (
                <ul className="list-disc space-y-0.5 pl-4 text-xs [color:#b45309]" data-testid="public-page-blockers">
                    {lines.map((l) => <li key={l}>{l}</li>)}
                </ul>
            ) : null}
            {state.pages.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_public.urls.none', 'No public URL yet.')}</p>
            ) : (
                <ul className="space-y-1.5">
                    {state.pages.map((p) => (
                        <UrlRow key={p.token} t={t} page={p} confirming={confirming === p.token} busy={revoke.isPending}
                            onAsk={() => setConfirming(p.token)} onCancel={() => setConfirming(null)} onRevoke={() => doRevoke(p.token)} />
                    ))}
                </ul>
            )}
            <div className="flex items-center gap-2">
                <button type="button" className={BTN} onClick={doCreate} disabled={full || create.isPending}>
                    {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t('studio_apps_public.urls.create', 'Create a public URL')}
                </button>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {full
                        ? t('studio_apps_public.urls.full', 'An app has at most {max} public URLs. Revoke one to make another.', { max: MAX_PUBLIC_URLS })
                        : t('studio_apps_public.urls.limit', 'Up to {max} URLs, so you can replace a link without breaking the one already sent.', { max: MAX_PUBLIC_URLS })}
                </span>
            </div>
        </div>
    );
}

interface UrlRowProps {
    t: TranslateFn;
    page: PublicPageRow;
    confirming: boolean;
    busy: boolean;
    onAsk: () => void;
    onCancel: () => void;
    onRevoke: () => void;
}

function UrlRow({ t, page, confirming, busy, onAsk, onCancel, onRevoke }: UrlRowProps) {
    const copy = () => copyText(page.url, { fallbackOnReject: true })
        .then(() => toast.success(t('studio_apps_public.urls.copied', 'Link copied.')))
        .catch(() => toast.error(t('studio_apps_public.urls.copy_failed', 'The link could not be copied.')));
    return (
        <li className="rounded-lg border px-2.5 py-2 text-xs border-[var(--border-subtle)] bg-[var(--bg-primary)]">
            <div className="flex items-center gap-2">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                <a href={page.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-mono text-[var(--accent-primary)] hover:underline">{page.url}</a>
                <span className="shrink-0 text-[var(--text-tertiary)]">{t('studio_apps_public.urls.visits', '{count} visits', { count: page.visits ?? 0 })}</span>
                <button type="button" className={BTN} onClick={copy} aria-label={t('studio_apps_public.urls.copy_aria', 'Copy {url}', { url: page.url })}>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />{t('studio_apps_public.urls.copy', 'Copy')}
                </button>
                {confirming ? null : (
                    <button type="button" className={BTN} onClick={onAsk} aria-label={t('studio_apps_public.urls.revoke_aria', 'Revoke {url}', { url: page.url })}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{t('studio_apps_public.urls.revoke', 'Revoke')}
                    </button>
                )}
            </div>
            {confirming ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[var(--text-secondary)]">{t('studio_apps_public.urls.revoke_confirm', 'Revoke this link? Anyone who has it can no longer open the page. This cannot be undone.')}</span>
                    <button type="button" className={`${BTN} [color:#b91c1c]!`} onClick={onRevoke} disabled={busy}>{t('studio_apps_public.urls.revoke_yes', 'Revoke link')}</button>
                    <button type="button" className={BTN} onClick={onCancel} disabled={busy}>{t('studio_apps_public.urls.revoke_no', 'Keep it')}</button>
                </div>
            ) : null}
        </li>
    );
}
