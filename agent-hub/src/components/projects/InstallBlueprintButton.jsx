import { AlertTriangle, Loader2, Upload } from 'lucide-react';
import React, { useRef, useState } from 'react';
import InstallBlueprintModal from './InstallBlueprintModal';
import useRemote from './useRemote';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE } from '../../utils/helpers';

/**
 * Install a Blueprint as a new Solution — the entry point, not the install.
 *
 * Lives on the projects LIST rather than inside a project, because installing
 * creates a project rather than acting on one.
 *
 * Picking a file, or a Blueprint kept on this instance, no longer installs it.
 * It opens InstallBlueprintModal, which shows what is in it, asks what the
 * recipient has to supply, and only then posts. The reason is in that file's
 * header: everything a Blueprint deliberately does not carry used to arrive
 * empty, and everything it asked for that an install refuses to grant used to
 * arrive refused, both explained only in a report that appeared after the fact.
 *
 * What stays here is the two ways to name a Blueprint and the one thing that
 * has to happen before either: reading the file, which is the only step that
 * can fail before there is a dialog to fail inside.
 */

/** Blueprints kept on this instance, installable without a file. */
function SavedGallery({ saved, status, onInstall }) {
    const { t } = useTranslation();
    if (status === 'error') {
        return (
            <p className="w-full flex items-start gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}
               data-testid="blueprint-gallery-unavailable">
                <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                {t('solutions.install_gallery_failed',
                    'The Blueprints kept on this instance could not be listed, so this is not "there are none". Installing from a file still works.')}
            </p>
        );
    }
    if (saved.length === 0) return null;
    return (
        <div className="w-full flex flex-wrap items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('projects.blueprint_saved_here', 'Kept on this instance')}:
            </span>
            {saved.map(b => (
                <button
                    key={b.id}
                    onClick={() => onInstall(b.id)}
                    className="px-2.5 py-1 rounded-lg text-xs border"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    {b.name} · v{b.version}
                </button>
            ))}
        </div>
    );
}

/**
 * `showGallery` is false wherever the screen already lists the Blueprints kept
 * on this instance — the Solutions overview does, as its Catalogue tab. The
 * chips are then not merely redundant but a second, differently-shaped answer
 * to the same question a few pixels away, and the fetch behind them a second
 * request for a list already on screen.
 */
export default function InstallBlueprintButton({ onInstalled, showGallery = true }) {
    const { t } = useTranslation();
    const inputRef = useRef(null);
    const [error, setError] = useState('');
    const [source, setSource] = useState(null);
    // Blueprints kept on this instance. An empty gallery and a gallery that
    // could not be read are different answers, and the second one says so —
    // silence there taught people their organisation had none.
    const gallery = useRemote(`${API_BASE}/api/projects/package/blueprints`, showGallery);
    const saved = gallery.data?.blueprints || [];
    const savedStatus = gallery.status;

    const onPick = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';           // so the same file can be picked twice
        if (!file) return;
        setError('');
        try {
            setSource({ manifest: JSON.parse(await file.text()) });
        } catch {
            setError(t('projects.blueprint_not_json', 'That file is not a Blueprint.'));
        }
    };

    return (
        <>
            <button
                onClick={() => inputRef.current?.click()}
                className="px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1 border"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                data-testid="projects-page-install-blueprint"
            >
                {savedStatus === 'loading'
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Upload className="w-3.5 h-3.5" />}
                {t('projects.blueprint_install', 'Install a Blueprint')}
            </button>
            <input
                ref={inputRef}
                type="file"
                accept="application/json,.json"
                onChange={onPick}
                className="hidden"
                aria-hidden="true"
            />

            {showGallery && (
                <SavedGallery
                    saved={saved}
                    status={savedStatus}
                    onInstall={(id) => { setError(''); setSource({ blueprintId: id }); }}
                />
            )}

            {error && (
                <p className="w-full flex items-start gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                    {error}
                </p>
            )}

            <InstallBlueprintModal
                open={!!source}
                source={source}
                onClose={() => setSource(null)}
                onInstalled={onInstalled}
            />
        </>
    );
}
