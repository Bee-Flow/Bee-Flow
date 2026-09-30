import { AlertTriangle, Download, Loader2, Package } from 'lucide-react';
import React, { useState } from 'react';
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
 * something behind — a routine it could not carry, a database it must not, a
 * file this version does not — reads as a complete copy until the day someone
 * installs it. So every one of those is listed, in words, before the download.
 */

function humanError(status, body) {
    if (body?.error === 'feature_locked') {
        return `Packaging a Solution is part of the ${body.required} plan. This organisation is on ${body.current}.`;
    }
    if (status === 403) return 'Only the project owner can package it — export reads every member\'s work, not just yours.';
    if (status === 404) return 'This project could not be read.';
    return body?.error || 'The export failed.';
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
        <div>
            <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{title}</h3>
            <ul className="space-y-1">
                {items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg text-sm"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                        {render(item)}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function Result({ manifest, projectName }) {
    const { t } = useTranslation();
    const report = manifest?.solution?.report;
    const counts = report?.counts || {};
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {counts.automations || 0} routines · {counts.apps || 0} apps · {counts.webpages || 0} webpages
                </span>
                <button
                    onClick={() => download(manifest, projectName)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    <Download className="w-3.5 h-3.5" />
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
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
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
            if (!res.ok) { setError(humanError(res.status, body)); return; }
            // The capture succeeded even if keeping it did not — the manifest
            // still downloads, so say what failed rather than losing the work.
            if (body._saveError) setError(body._saveError);
            setManifest(body);
        } catch {
            setError('The export failed.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-5">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('projects.blueprint_intro',
                    'A Blueprint is this Solution written down — its routines, apps and webpages, and the links between them — so it can be installed somewhere else. Decisions, credentials and people never travel with it.')}
            </p>

            <button
                onClick={run}
                disabled={busy || !isOwner}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
                {t('projects.blueprint_export', 'Package this Solution')}
            </button>

            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={keepHere} onChange={(e) => setKeepHere(e.target.checked)}
                       disabled={!isOwner || forceKeepHere} />
                {t('projects.blueprint_keep_here',
                    'Also keep it on this instance, so colleagues can install it without a file')}
            </label>

            {!isOwner && (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('projects.blueprint_owner_only', 'Only the project owner can package it.')}
                </p>
            )}

            {error && (
                <p className="flex items-start gap-2 px-3 py-2 rounded-lg text-sm"
                   style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                    {error}
                </p>
            )}

            {manifest && <Result manifest={manifest} projectName={projectName} />}
        </div>
    );
}
