import { Palette, Package } from 'lucide-react';
import { useState } from 'react';
import IconsEditor from './icons/IconsEditor';
import LookEditor from './look/LookEditor';
import SectionNav from '../../shared/SectionNav';
import StudioShell from '../../shared/StudioShell';
import { useTranslation } from '@/hooks/useTranslation';

type AppearanceSection = 'look' | 'icons';

/**
 * AppearancePanel — top-level admin Appearance, a StudioShell with two
 * sections: **Look** (theme + wallpaper in one scrolling editor) and **Icons**
 * (asset management, kept apart because its UX is a different domain). While
 * Look is open, its table of contents sits in the sidebar under the "Look"
 * row: the editor renders it into the slot below the section list.
 */
export default function AppearancePanel() {
    const { t } = useTranslation();
    const [active, setActive] = useState<AppearanceSection>('look');
    const [lookNavSlot, setLookNavSlot] = useState<HTMLDivElement | null>(null);

    const sidebar = (
        <>
            <SectionNav
                label={t('appearance.panel_sections', 'Appearance sections')}
                items={[
                    { id: 'look', label: t('appearance.look_editor_look', 'Look'), icon: Palette },
                    { id: 'icons', label: t('appearance.panel_icons', 'Icons'), icon: Package },
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
