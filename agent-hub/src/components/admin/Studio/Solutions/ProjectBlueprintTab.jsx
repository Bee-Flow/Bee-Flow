import { AlertTriangle, Download, Loader2, Package } from 'lucide-react';
import React, { useState } from 'react';
import Notice from './Notice';
import { CARD, ROW, TabCard } from './TabParts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * Package this Solution as a Blueprint.
 *
 * Export is owner-only and licence-gated, and both refusals come from the
 * server. The button is shown rather than hidden on a locked plan, and the
 * server's own answer is rendered — an explicit "this needs a different plan"
 * is more use than a control that silently is not there.
 *
 * The summary is only shown AFTER an export, and it is the manifest's own
 * report rather than a second count computed here. What a Blueprint says it
 * contains and what it contains are then the same thing by construction.
 *
 * Warnings are the point of this screen. A Blueprint that quietly left
 * something behind — an automation it could not carry, a database it must not, a
 * file this version does not — reads as a complete copy until the day someone
 * installs it. So every one of those is listed, in words, before the download.
 */

function humanError(status, body, t) {
    if (body?.error === 'feature_locked') {
        return t('studio_misc.blueprint.err_locked', 'Packaging a Solution is part of the {required} plan. This organisation is on {current}.', { required: body.required, current: body.current });
    }
    if (status === 403) return t('studio_misc.blueprint.err_owner_only', 'Only the project owner can package it — export reads every member\'s work, not just yours.');
    if (status === 404) return t('studio_misc.blueprint.err_not_found', 'This project could not be read.');
    return body?.error || t('studio_misc.blueprint.err_export', 'The export failed.');
}

function download(manifest, name) {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || 'solution').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.blueprint.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function Listed({ title, items, render }) {
    if (!items || items.length === 0) return null;
    return (
        <TabCard title={title}>
            <ul className="space-y-1">
                {items.map((item, i) => (
                    <li key={i} className={`flex items-start gap-2 px-3 py-2 ${ROW} text-sm text-[var(--text-secondary)]`}>
                        {render(item)}
                    </li>
                ))}
            </ul>
        </TabCard>
    );
}

function Result({ manifest, projectName }) {
    const { t } = useTranslation();
    const report = manifest?.solution?.report;
    const counts = report?.counts || {};
    return (
        <div className="space-y-4">
            <div className={`${CARD} flex flex-wrap items-center justify-between gap-3`}>
                <span className="text-sm tabular-nums text-[var(--text-secondary)]">
                    {t('studio_misc.blueprint.counts', '{automations} automations · {apps} apps · {webpages} webpages', { automations: counts.automations || 0, apps: counts.apps || 0, webpages: counts.webpages || 0 })}
                </span>
                <button
                    onClick={() => download(manifest, projectName)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] sm:min-h-[36px] rounded-[var(--radius-md)] text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    {t('projects.blueprint_download', 'Download')}
                </button>
            </div>

            <Listed
                title={t('projects.blueprint_requires', 'Whoever installs it has to supply')}
                items={manifest?.solution?.requires || []}
                render={(r) => <span>{r.count} × {r.kind}</span>}
            />

            {/* The point of this screen. A Blueprint that quietly left something
                behind reads as a complete copy until the day someone installs it. */}
            <Listed
                title={t('projects.blueprint_left_behind', 'What this Blueprint does not carry')}
                items={report?.warnings || []}
                render={(w) => (
                    <>
                        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--warning)]" aria-hidden="true" />
                        {w}
                    </>
                )}
            />
        </div>
    );
}

/**
 * `forceKeepHere` is the PUBLISH entry point (SolutionExportDialog mode
 * 'publish'): publishing a Solution IS keeping it on this instance, so the
 * choice is made rather than asked and the checkbox says so instead of offering
 * an option that would contradict the button that opened it. Left undefined —
 * every caller that predates the dialog — the screen behaves exactly as before:
 * off by default, and the user's own decision.
 */
export default function ProjectBlueprintTab({ projectId, projectName, role, forceKeepHere = false }) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [manifest, setManifest] = useState(null);
    const [error, setError] = useState('');
    // Off by default: a download is the more private choice, and only what is
    // kept on the instance is subject to the size ceiling.
    const [keepHereChoice, setKeepHere] = useState(false);
    const keepHere = forceKeepHere || keepHereChoice;

    const isOwner = role === 'owner';

    const run = async () => {
        setBusy(true);
        setError('');
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}/package/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ save: keepHere }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { setError(humanError(res.status, body, t)); return; }
            // The capture succeeded even if keeping it did not — the manifest
            // still downloads, so say what failed rather than losing the work.
            if (body._saveError) setError(body._saveError);
            setManifest(body);
        } catch {
            setError(t('studio_misc.blueprint.err_export', 'The export failed.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-5">
            <section className={`${CARD} space-y-4`}>
                <p className="text-[13px] text-[var(--text-secondary)]">
                    {t('projects.blueprint_intro',
                        'A Blueprint is this Solution written down — its automations, apps and webpages, and the links between them — so it can be installed somewhere else. Decisions, credentials and people never travel with it.')}
                </p>

                <label className="flex items-start gap-3 min-h-[44px] sm:min-h-0 text-sm text-[var(--text-secondary)]">
                    <input type="checkbox" checked={keepHere} onChange={(e) => setKeepHere(e.target.checked)}
                           disabled={!isOwner || forceKeepHere}
                           className="mt-0.5 w-4 h-4 flex-shrink-0 accent-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]" />
                    {t('projects.blueprint_keep_here',
                        'Also keep it on this instance, so colleagues can install it without a file')}
                </label>

                <button
                    onClick={run}
                    disabled={busy || !isOwner}
                    className="inline-flex w-full sm:w-auto items-center justify-center gap-2 px-4 min-h-[44px] rounded-[var(--radius-md)] text-sm font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2"
                >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Package className="w-4 h-4" />}
                    {t('projects.blueprint_export', 'Package this Solution')}
                </button>

                {!isOwner && (
                    <p className="text-xs text-[var(--text-tertiary)]">
                        {t('projects.blueprint_owner_only', 'Only the project owner can package it.')}
                    </p>
                )}
            </section>

            {error && <Notice tone="error">{error}</Notice>}

            {manifest && <Result manifest={manifest} projectName={projectName} />}
        </div>
    );
}
