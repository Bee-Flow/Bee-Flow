import { Plus } from 'lucide-react';
import type React from 'react';
import type { KnowledgeBase } from './knowledgeApi';
import { sharedGroupsOf } from './sharedGroups';
import type { TranslateFn } from '@/hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import VisibilityCapsule from '@/components/shared/VisibilityCapsule';
import type { OrgGroup } from '@/components/shared/VisibilityCapsule.types';

// The header pieces of KnowledgeDetail: the audience capsule and "Add a source".

interface KbAudienceCapsuleProps {
    kb: KnowledgeBase | null;
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    canManage: boolean;
    orgGroups: readonly OrgGroup[];
    setAudience: (body: { isPublished: boolean; sharedGroups: string[] }) => Promise<void>;
}

/** Who may see the knowledge base: personal, the whole organisation, or chosen groups (widening asks first). */
export function KbAudienceCapsule({ kb, open, setOpen, canManage, orgGroups, setAudience }: KbAudienceCapsuleProps) {
    return (
        <VisibilityCapsule
            variant="capsule"
            anchored
            agent={kb}
            open={open}
            onToggle={() => setOpen(v => !v)}
            onClose={() => setOpen(false)}
            disabled={!canManage}
            isPublished={!!kb?.is_published}
            sharedGroups={sharedGroupsOf(kb)}
            orgGroups={orgGroups}
            confirmWidening
            onSetPersonal={() => setAudience({ isPublished: false, sharedGroups: [] })}
            onSetEntireOrg={() => setAudience({ isPublished: true, sharedGroups: [] })}
            onToggleGroup={(gid) => {
                const cur = sharedGroupsOf(kb);
                const next = cur.includes(gid) ? cur.filter((g) => g !== gid) : [...cur, gid];
                return setAudience({ isPublished: true, sharedGroups: next });
            }}
        />
    );
}

/** The header's "Add a source": it moves focus to the add-source panel rather than opening a second copy of it. */
export function AddSourceButton({ t, onClick }: { t: TranslateFn; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
        >
            <Plus className="w-3 h-3" aria-hidden="true" />
            {t('knowledge.add_source', 'Add a source')}
        </button>
    );
}
