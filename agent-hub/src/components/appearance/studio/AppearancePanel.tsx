import { Palette, Package } from 'lucide-react';
import { useState } from 'react';
import IconsEditor from './icons/IconsEditor';
import LookEditor from './look/LookEditor';
import SectionNav from '../../shared/SectionNav';
import StudioShell from '../../shared/StudioShell';
import { useTranslation } from '@/hooks/useTranslation';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';

type AppearanceSection = 'look' | 'icons';

/**
 * AppearancePanel — Whole server > Appearance, two sections:
 *   **Look**        the theme and wallpaper for everyone on this server (one
 *                   server-wide default, not one organisation's);
 *   **Icon packs**  authoring icon packs (create, edit, generate, export).
 *                   Which pack a person USES is their own choice, made in
 *                   Settings > Appearance (pages/settings/IconPackChoice).
 * The dashboard mounts one section per rail row (`section`); without it the
 * panel keeps its own section column, and while Look is open its table of
 * contents sits in that column under the "Look" row.
 */
interface AppearancePanelProps {
    /**
     * The section to show without the section column (the admin dashboard's
     * child rows: admin/appearance/look, admin/appearance/icon-packs). Left out:
     * both, with the column, Look first.
     */
    section?: 'look' | 'icon-packs';
}

export default function AppearancePanel({ section }: AppearancePanelProps = {}) {
    const { t } = useTranslation();
    const [activeState, setActive] = useState<AppearanceSection>('look');
    const active: AppearanceSection = section ? (section === 'icon-packs' ? 'icons' : 'look') : activeState;
    // Look is server-wide; the icon packs are the viewer's own.
    useAdminScopeOverride(active === 'icons' ? 'user' : null);
    const [lookNavSlot, setLookNavSlot] = useState<HTMLDivElement | null>(null);

    if (section) {
        return <div className="h-full">{active === 'look' ? <LookEditor /> : <IconsEditor />}</div>;
    }

    const sidebar = (
        <>
            <SectionNav
                label={t('appearance.panel_sections', 'Appearance sections')}
                items={[
                    { id: 'look', label: t('appearance.look_editor_look', 'Look'), icon: Palette },
                    { id: 'icons', label: t('admin_nav.icon_packs', 'Icon packs'), icon: Package },
                ]}
                activeId={active}
                onSelect={(id) => setActive(id as AppearanceSection)}
            />
            {active === 'look' ? <div ref={setLookNavSlot} className="hidden px-2 pb-2 md:block" /> : null}
        </>
    );

    return (
        <StudioShell responsive sidebarTitle={t('admin.tab_appearance', 'Appearance')} sidebar={sidebar}>
            <div className="h-full">
                {active === 'look' ? <LookEditor navSlot={lookNavSlot} /> : <IconsEditor />}
            </div>
        </StudioShell>
    );
}
