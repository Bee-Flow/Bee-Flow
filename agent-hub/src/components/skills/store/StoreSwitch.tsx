import { Bot, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import scopedStorage from '@/utils/scopedStorage';

/**
 * The store's two shelves: Agents (the Agent store, AgentMarketplace) and
 * Skills (the Skill store). One entry, the sidebar's "Agents" item that
 * already opens the Agent store, with a tab strip on top, instead of a second
 * menu item for something people look for in the same place. The last shelf
 * is remembered per browser.
 */
const SHELF_KEY = 'store_shelf';

export default function StoreSwitch({ agents, skills }: { agents: ReactNode; skills: ReactNode }) {
    const { t } = useTranslation();
    const [shelf, setShelf] = useState<'agents' | 'skills'>(() => (scopedStorage.getJSON<string>(SHELF_KEY, 'agents') === 'skills' ? 'skills' : 'agents'));
    const pick = (next: 'agents' | 'skills') => {
        scopedStorage.setJSON(SHELF_KEY, next);
        setShelf(next);
    };
    const tab = (key: 'agents' | 'skills', label: string, Icon: typeof Bot) => (
        <button
            type="button"
            role="tab"
            aria-selected={shelf === key}
            onClick={() => pick(key)}
            data-testid={`store-shelf-${key}`}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition ${shelf === key
                ? 'border-[var(--accent-primary)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
        >
            <Icon size={13} aria-hidden="true" /> {label}
        </button>
    );
    return (
        <div className="flex-1 flex flex-col overflow-hidden w-full h-full">
            <div role="tablist" aria-label={t('skillStore.shelves', 'Store')} className="flex items-center gap-1 px-6 border-b bg-[var(--bg-primary)] border-[var(--border-subtle)]">
                {tab('agents', t('skillStore.shelf_agents', 'Agents'), Bot)}
                {tab('skills', t('skillStore.shelf_skills', 'Skills'), Sparkles)}
            </div>
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">{shelf === 'skills' ? skills : agents}</div>
        </div>
    );
}
