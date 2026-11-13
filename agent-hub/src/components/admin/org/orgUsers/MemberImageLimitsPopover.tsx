import { useRef, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import useOutsideDismiss from '@/hooks/useOutsideDismiss';
import { hasImageLimits } from '@/utils/imageLimits';
import ImageLimitsEditor from '../imageLimits/ImageLimitsEditor';
import type { OrgMember } from '../useOrgDirectory';
import type { OrgMemberRoles } from '../useOrgMemberRoles';

/**
 * A member's own image limits behind one icon on their row (four inputs do
 * not fit in the row itself). The icon is filled in when the member has a
 * limit of their own.
 */
export default function MemberImageLimitsPopover({ member: u, memberRoles }: { member: OrgMember; memberRoles: OrgMemberRoles }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useOutsideDismiss(ref, () => setOpen(false), { enabled: open });
    const label = t('image_limits.user_label', 'Image limits');
    const hasOwn = hasImageLimits(u.imageLimits);
    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                title={label}
                aria-label={label}
                aria-expanded={open}
                className={`p-1 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors ${hasOwn ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
                <ImageIcon className="w-3.5 h-3.5" />
            </button>
            {open && (
                <div className="absolute right-0 top-full mt-1 w-80 max-w-[calc(100vw-2rem)] p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-xl z-50">
                    <ImageLimitsEditor
                        value={u.imageLimits}
                        label={label}
                        hint={t('image_limits.user_hint', "This person's own limits. An empty window uses their groups (the most generous one), then the organisation's default. 0 lifts the limit for them.")}
                        onSave={limits => memberRoles.handleUpdateUserImageLimits(u.id, limits)}
                    />
                </div>
            )}
        </div>
    );
}
