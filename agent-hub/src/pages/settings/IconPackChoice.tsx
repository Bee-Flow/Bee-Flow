import { useState } from 'react';
import { Package, Shapes } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { iconPackKeys, useIconPackListQuery, type IconPackList } from '@/api/queries/iconPacks';
import { apiRequest } from '@/api/typedRequest';
import { useIconPack } from '@/hooks/useIconPack';
import { useTranslation } from '@/hooks/useTranslation';
import ChoiceCards from '@/components/shared/ChoiceCards';
import SaveStatus from '@/components/shared/SaveStatus';

/** A pack as the list reads it: the id, the name and how many icons it replaces. */
interface PackRow {
    id: string;
    name: string;
    icons?: Record<string, unknown>;
}

/** The value of the standard icons (the activate route takes 'default'). */
const STANDARD = 'default';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Settings > Appearance: the icon pack the person uses. A pack belongs to
 * whoever made it (Whole server > Appearance > Icon packs), and choosing one is
 * personal (POST /api/icons/:id/activate stores it on the user), so the choice
 * sits here, next to the theme, and not among the server-wide settings.
 * Nothing is shown while the person has no pack of their own: the only option
 * would be the standard icons.
 */
export default function IconPackChoice() {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const iconPack = useIconPack();
    const packsQuery = useIconPackListQuery<PackRow>();
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const packs = packsQuery.data?.packs ?? [];
    if (packs.length === 0) return null;

    const active = iconPack.activePackId ?? packsQuery.data?.activeIconPackId ?? null;

    const choose = async (value: string) => {
        const id = value === STANDARD ? null : value;
        setSaveState('saving');
        try {
            await apiRequest('POST /api/icons/{id}/activate', { params: { id: value } });
            // The icon provider switches the app's icons (it stores the same choice once more).
            await iconPack.setIconPack(id);
        } catch {
            // A refusal or a dropped connection: say so, and leave the cards usable.
            setSaveState('error');
            return;
        }
        qc.setQueryData<IconPackList<PackRow, unknown>>(iconPackKeys.list(), (prev) => prev && { ...prev, activeIconPackId: id });
        setSavedAt(new Date());
        setSaveState('saved');
    };

    const options = [
        { value: STANDARD, label: t('platform_panels.icon_pack_default', 'Standard icons'), description: t('platform_panels.icon_pack_default_desc', 'The icons Bee Flow comes with.'), Icon: Shapes },
        ...packs.map(p => ({
            value: p.id,
            label: p.name,
            description: t('platform_panels.icon_packs_count', '{n} custom icons', { n: Object.keys(p.icons || {}).length }),
            Icon: Package,
        })),
    ];

    return (
        <section aria-labelledby="settings-icon-pack-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
                <h3 id="settings-icon-pack-heading" className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {t('platform_panels.icon_pack', 'Icon pack')}
                </h3>
                <SaveStatus saveState={saveState} lastSavedAt={savedAt} />
            </div>
            <p className="text-xs mb-3 text-[var(--text-muted)]">
                {t('platform_panels.icon_pack_hint', 'Replaces the icons in the app. Only you see your choice.')}
            </p>
            <ChoiceCards
                value={active ?? STANDARD}
                onChange={(next: string) => { void choose(next); }}
                options={options}
                disabled={saveState === 'saving'}
                ariaLabel={t('platform_panels.icon_pack', 'Icon pack')}
            />
        </section>
    );
}
