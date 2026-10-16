import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HeaderApp } from './headerModel';
import useTranslation from '../../../../../../hooks/useTranslation';
import { kindTileStyle } from '../../../../../shared/kindColors';
import toast from '../../../../../shared/Toast';
import { studioAppsApi } from '../../studioAppsApi';
import AppIcon from '../../../../../icons/AppIcon';
import { errorMessage } from '../../../../../../utils/caughtError';

interface AppNameFieldProps {
    app: HeaderApp;
    /** Renaming is off while the AI streams and on a managed app. */
    locked: boolean;
    isManaged: boolean;
    noteRefusal: (err: unknown) => boolean;
    onAppUpdated?: (app: HeaderApp) => void;
}

/** The app's name in the header: a button that turns into an inline rename field. */
function AppNameField({ app, locked, isManaged, noteRefusal, onAppUpdated }: AppNameFieldProps) {
    const { t } = useTranslation();
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState(app?.name || '');
    const nameInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (editingName) nameInputRef.current?.select();
    }, [editingName]);

    const commitName = async () => {
        setEditingName(false);
        const name = nameDraft.trim();
        if (!name || name === app?.name) {
            setNameDraft(app?.name || '');
            return;
        }
        try {
            const updated = await studioAppsApi.updateApp(app.id, { name });
            onAppUpdated?.(updated?.app || updated || { ...app, name });
        } catch (err) {
            noteRefusal(err);
            setNameDraft(app?.name || '');
            const message = errorMessage(err);
            toast.error((typeof message === 'string' && message) || t('app_studio.header.rename_failed', 'Could not rename the app.'));
        }
    };

    if (editingName) {
        return (
            <input
                ref={nameInputRef}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commitName();
                    else if (e.key === 'Escape') {
                        setNameDraft(app?.name || '');
                        setEditingName(false);
                    }
                }}
                aria-label={t('app_studio.header.name_aria', 'App name')}
                className="w-48 rounded border px-2 py-1 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                style={{
                    background: 'var(--bg-secondary)',
                    borderColor: 'var(--accent-primary)',
                    color: 'var(--text-primary)',
                }}
            />
        );
    }
    return (
        <button
            type="button"
            onClick={() => !locked && !isManaged && setEditingName(true)}
            title={isManaged ? t('managed_part.read_only_hint', 'Read-only: this part is managed by a Solution stage.') : t('app_studio.header.rename', 'Rename app')}
            className="group inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-sm font-semibold hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
        >
            <span className="truncate max-w-[14rem]">{app?.name || t('app_studio.header.untitled', 'Untitled app')}</span>
            <Pencil
                className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: 'var(--text-tertiary)' }}
                aria-hidden="true"
            />
        </button>
    );
}

/** App identity + rename — the 28px kind tile of every Studio header, then the name. */
export default function AppIdentity({ icon, ...nameProps }: AppNameFieldProps & { icon?: string }) {
    const tile = kindTileStyle('app', { size: 28, pct: 18 });
    return (
        <>
            <span style={tile.tile} data-testid="studio-section-kind" data-kind="app" aria-hidden="true">
                <AppIcon name={icon || nameProps.app?.icon || 'LayoutGrid'} style={tile.glyph} />
            </span>
            <AppNameField {...nameProps} />
        </>
    );
}
