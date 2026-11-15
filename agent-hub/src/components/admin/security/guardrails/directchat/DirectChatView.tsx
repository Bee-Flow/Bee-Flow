import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';
import Toggle from '@/components/shared/Toggle';
import SaveFooter from '@/components/shared/SaveFooter';
import { ALERT_WARNING } from '@/components/shared/adminUi';
import { saveDirectChatGuardrails } from '../api/guardrailsApi';
import { messageOf } from '@/utils/caughtError';
import type { DirectChatBinding } from '../api/guardrailsApi';
import type { RuleCollection } from '../patterns/patternTypes';

interface DirectChatViewProps {
    collections: RuleCollection[];
    directChat: DirectChatBinding;
    setDirectChat: (config: DirectChatBinding) => void;
    onSaved?: () => void;
}

/**
 * Regex collections applied to direct chat.
 *
 * Worth being explicit about the scope, because the old UI was not: this is
 * ONE switch and ONE collection list for every organisation on the
 * installation. It is stored under `direct_chat_regex_guardrails`, not per org,
 * so an admin flipping it here changes direct chat for every tenant at once.
 */
const DirectChatView = ({ collections, directChat, setDirectChat, onSaved }: DirectChatViewProps) => {
    const { t } = useTranslation();
    const [saving, setSaving] = useState(false);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [savedAt, setSavedAt] = useState<Date | null>(null);

    const toggleCollection = (id: string) => {
        const has = directChat.collectionIds.includes(id);
        setDirectChat({
            ...directChat,
            collectionIds: has
                ? directChat.collectionIds.filter(c => c !== id)
                : [...directChat.collectionIds, id],
        });
    };

    const handleSave = async () => {
        setSaving(true);
        setSaveState('saving');
        try {
            await saveDirectChatGuardrails(directChat);
            setSaveState('saved');
            setSavedAt(new Date());
            toast.success(t('admin.guard_saved'));
            onSaved?.();
        } catch (e) {
            setSaveState('error');
            toast.error(messageOf(e, t('common.save_failed', 'Could not save')));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-6">
            {/* The tab names the view ("Direct chat"); the page title is the dashboard frame's. */}
            <p className="text-sm text-[var(--text-secondary)]">
                {t('admin.gr_directchat_desc', 'Collections applied to direct chat across this whole installation.')}
            </p>

            {/* Scope warning: this is not per-organisation, and nothing on the old
                screen said so. */}
            <p className={ALERT_WARNING}>
                {t('admin.gr_directchat_scope_note', 'This setting is installation-wide. Every organisation shares it — per-organisation rules are configured on the Organisations tab.')}
            </p>

            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-5 space-y-4">
                <Toggle
                    checked={directChat.enabled}
                    onChange={(v: boolean) => setDirectChat({ ...directChat, enabled: v })}
                    label={t('admin.gr_directchat_enable', 'Apply regex collections to direct chat')}
                    description={t('admin.gr_directchat_enable_desc', 'Scan direct-chat messages in both directions and remove anything a selected collection matches.')}
                />

                {directChat.enabled && (
                    <div>
                        <p className="text-xs font-medium text-[var(--text-tertiary)] mb-2">
                            {t('admin.gr_directchat_collections', 'Collections')}
                        </p>
                        {collections.length === 0 ? (
                            <p className="text-sm text-[var(--text-tertiary)] italic">
                                {t('admin.gr_patterns_create_rules_first', 'Create rules first.')}
                            </p>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {collections.map(col => (
                                    <label
                                        key={col.id}
                                        className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors
                                                    ${directChat.collectionIds.includes(col.id)
                                                ? 'bg-[var(--item-active-bg)] border-[var(--text-primary)]'
                                                : 'bg-[var(--bg-primary)] border-[var(--border-subtle)] hover:border-[var(--border-default)]'}`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={directChat.collectionIds.includes(col.id)}
                                            onChange={() => toggleCollection(col.id)}
                                            className="w-4 h-4 rounded accent-[var(--text-primary)]
                                                       focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                                        />
                                        <span className="text-sm text-[var(--text-primary)]">{col.name}</span>
                                        <span className="ml-auto text-xs text-[var(--text-tertiary)]">{col.ruleIds?.length || 0}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <SaveFooter
                onSave={handleSave}
                saving={saving}
                saveState={saveState}
                lastSavedAt={savedAt}
                onRetry={handleSave}
                saveLabel={t('admin.guard_save_all')}
            />
        </div>
    );
};

export default DirectChatView;
