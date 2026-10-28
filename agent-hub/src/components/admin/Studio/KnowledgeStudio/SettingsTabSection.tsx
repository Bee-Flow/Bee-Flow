import { Building2 } from 'lucide-react';
import { type KnowledgeBase } from './knowledgeApi';
import AudienceRows from '@/components/shared/AudienceRows';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { OrgGroup } from '@/components/shared/VisibilityCapsule.types';
import type { PersonalNoticeProps } from './SettingsTab.types';

export function SettingsTabSection({ isPersonal, t, canManage, orgId, moveToOrg, saving, kb, view, orgGroups, setAudience }: { isPersonal: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; canManage: boolean; orgId: string | null; moveToOrg: () => Promise<void>; saving: boolean; kb: KnowledgeBase | null; view: { orgId: string | null; isPublished: boolean; sharedGroups: string[]; categoryId: string | null; }; orgGroups: readonly OrgGroup[]; setAudience: (body: { isPublished: boolean; sharedGroups: string[]; }) => Promise<void>; }) {
    return <section className="flex flex-col gap-2" data-testid="kb-audience">
        {isPersonal ? (
            <PersonalNotice
                t={t}
                canMove={canManage && !!orgId}
                onMove={moveToOrg}
                busy={saving} />
        ) : (
            <AudienceRows
                agent={kb}
                isPublished={view.isPublished}
                sharedGroups={view.sharedGroups}
                orgGroups={orgGroups}
                disabled={!canManage}
                confirmWidening
                title={t('knowledge.settings.who_title', 'Who may see and use it')}
                hint={t('knowledge.settings.who_hint', 'An agent can only answer from this knowledge base for someone who may see it. Everyone else gets the same answer with this left out — never an error.')}
                onSetPersonal={() => setAudience({ isPublished: false, sharedGroups: [] })}
                onSetEntireOrg={() => setAudience({ isPublished: true, sharedGroups: [] })}
                onToggleGroup={(gid) => {
                    const cur = view.sharedGroups;
                    const next = cur.includes(gid) ? cur.filter((g) => g !== gid) : [...cur, gid];
                    return setAudience({ isPublished: true, sharedGroups: next });
                } } />
        )}
    </section>;
}

function PersonalNotice({ t, canMove, onMove, busy }: PersonalNoticeProps) {
    return (
        <div
            className="flex flex-col gap-2 p-3 rounded-[10px] [border:1px_solid_var(--border-default)] [background:var(--bg-card)]"
            data-testid="kb-personal-notice"
        >
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <Building2 className="w-[14px] h-[14px]" aria-hidden="true" />
                {t('knowledge.settings.personal_title', 'Personal — only you can see this')}
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.settings.personal_hint', 'A personal knowledge base cannot be shared. Move it into your organisation to choose an audience.')}
            </p>
            {canMove && (
                <button
                    type="button"
                    onClick={onMove}
                    disabled={busy}
                    data-testid="kb-move-to-org"
                    className="self-start px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [background:var(--accent-primary)] [color:var(--accent-primary-fg)]! [outline-color:var(--accent-primary)]!"
                >
                    {t('knowledge.settings.move_to_org', 'Move to my organisation')}
                </button>
            )}
            {canMove && (
                <p className="text-[11px] text-[var(--text-tertiary)]">
                    {/* The consequence, before the button rather than after it. */}
                    {t('knowledge.settings.move_consequence', 'It stays unshared until you pick an audience — but administrators will be able to see and manage it, and this cannot be undone.')}
                </p>
            )}
        </div>
    );
}
