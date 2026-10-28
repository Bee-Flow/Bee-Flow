import { Package, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EMPTY_NOTE, INPUT, PANEL, PANEL_TITLE, SECONDARY_BUTTON } from './patternTypes';
import type { PatternLibraryProps, RegexRule, RuleCollection } from './patternTypes';
import { useTranslation } from '@/hooks/useTranslation';

interface CollectionCardProps {
    col: RuleCollection;
    rules: RegexRule[];
    editing: boolean;
    onToggleEdit: () => void;
    onRemove: () => void;
    onToggleRule: (ruleId: string) => void;
}

/** Edit mode: one checkbox per rule. */
function RulePicker({ col, rules, onToggleRule }: Pick<CollectionCardProps, 'col' | 'rules' | 'onToggleRule'>) {
    const { t } = useTranslation();
    return (
        <div className="p-3 bg-black/10 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {rules.map(rule => {
                const member = col.ruleIds.includes(rule.id);
                return (
                    <label
                        key={rule.id}
                        className={`flex items-center gap-2.5 p-2 rounded-lg border cursor-pointer transition-colors ${member
                            ? 'bg-[var(--accent-primary)]/10 border-[var(--accent-primary)]/30'
                            : 'bg-white/5 border-transparent hover:border-white/10'}`}
                    >
                        <input
                            type="checkbox"
                            checked={member}
                            onChange={() => onToggleRule(rule.id)}
                            className="w-4 h-4 rounded border-gray-600 bg-transparent text-[var(--accent-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                        />
                        <span className={`text-sm ${member ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>
                            {rule.name}
                        </span>
                    </label>
                );
            })}
            {rules.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)] italic sm:col-span-2">
                    {t('admin.gr_patterns_create_rules_first', 'Create rules first.')}
                </p>
            )}
        </div>
    );
}

/** Read mode: the first five member rules as chips. */
function MemberChips({ col, rules }: Pick<CollectionCardProps, 'col' | 'rules'>) {
    return (
        <div className="px-3 py-2.5 flex flex-wrap gap-2">
            {col.ruleIds.slice(0, 5).map(id => {
                const rule = rules.find(r => r.id === id);
                if (!rule) return null;
                return (
                    <span key={id} className="text-xs px-2 py-1 rounded bg-white/5 text-[var(--text-tertiary)] border border-white/5">
                        {rule.name}
                    </span>
                );
            })}
            {col.ruleIds.length > 5 && (
                <span className="text-xs text-[var(--text-tertiary)] py-1">+ {col.ruleIds.length - 5}</span>
            )}
        </div>
    );
}

function CollectionCard({ col, rules, editing, onToggleEdit, onRemove, onToggleRule }: CollectionCardProps) {
    const { t } = useTranslation();
    return (
        <div
            className="rounded-xl border bg-[var(--bg-tertiary)] transition-colors"
            style={{ borderColor: editing ? 'var(--accent-primary)' : 'var(--border-default)' }}
        >
            <div className="p-3 flex items-center justify-between border-b border-white/5">
                <div className="flex items-center gap-3 min-w-0">
                    <Package size={16} className="shrink-0 text-[var(--text-tertiary)]" />
                    <div className="min-w-0">
                        <h4 className="font-medium text-sm text-[var(--text-primary)] truncate">{col.name}</h4>
                        <span className="text-xs text-[var(--text-tertiary)]">
                            {t('admin.gr_patterns_rule_count', '{n} rule(s)').replace('{n}', String(col.ruleIds.length))}
                        </span>
                    </div>
                </div>
                <div className="flex gap-2 shrink-0">
                    <button
                        onClick={onToggleEdit}
                        aria-expanded={editing}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${editing
                            ? 'bg-[var(--accent-primary)] text-white'
                            : 'bg-white/5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
                    >
                        {editing ? t('admin.gr_done', 'Done') : t('admin.gr_edit', 'Edit')}
                    </button>
                    <button
                        onClick={onRemove}
                        aria-label={t('admin.gr_delete_collection', 'Delete collection')}
                        title={t('admin.gr_delete_collection', 'Delete collection')}
                        className="p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-red-400 hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                    >
                        <Trash2 size={16} />
                    </button>
                </div>
            </div>

            {editing ? (
                <RulePicker col={col} rules={rules} onToggleRule={onToggleRule} />
            ) : col.ruleIds.length > 0 && (
                <MemberChips col={col} rules={rules} />
            )}
        </div>
    );
}

/** The collections: create one, pick its rules, delete one. */
export default function CollectionsPanel({ rules, collections, setCollections }: Omit<PatternLibraryProps, 'setRules'>) {
    const { t } = useTranslation();
    const [newCollectionName, setNewCollectionName] = useState('');
    const [editingCollection, setEditingCollection] = useState<string | null>(null);

    const addCollection = () => {
        if (!newCollectionName.trim()) return;
        setCollections([...collections, { id: `c_${crypto.randomUUID()}`, name: newCollectionName.trim(), ruleIds: [] }]);
        setNewCollectionName('');
    };

    const removeCollection = (id: string) => setCollections(collections.filter(c => c.id !== id));

    const toggleRuleInCollection = (colId: string, ruleId: string) => {
        setCollections(collections.map(c => {
            if (c.id !== colId) return c;
            const has = c.ruleIds.includes(ruleId);
            return { ...c, ruleIds: has ? c.ruleIds.filter(r => r !== ruleId) : [...c.ruleIds, ruleId] };
        }));
    };

    return (
        <section className={PANEL}>
            <h3 className={PANEL_TITLE}>
                {t('admin.gr_patterns_collections', 'Collections')}
            </h3>
            <div className="flex gap-2 mb-4">
                <input
                    value={newCollectionName}
                    onChange={e => setNewCollectionName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addCollection()}
                    placeholder={t('admin.gr_patterns_new_collection', 'New collection name…')}
                    aria-label={t('admin.gr_patterns_new_collection', 'New collection name…')}
                    className={`flex-1 ${INPUT}`}
                />
                <button onClick={addCollection} className={SECONDARY_BUTTON}>
                    {t('admin.gr_create', 'Create')}
                </button>
            </div>

            <div className="space-y-3 max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
                {collections.length === 0 && (
                    <p className={EMPTY_NOTE}>
                        {t('admin.gr_patterns_no_collections', 'No collections yet.')}
                    </p>
                )}
                {collections.map(col => (
                    <CollectionCard
                        key={col.id}
                        col={col}
                        rules={rules}
                        editing={editingCollection === col.id}
                        onToggleEdit={() => setEditingCollection(editingCollection === col.id ? null : col.id)}
                        onRemove={() => removeCollection(col.id)}
                        onToggleRule={(ruleId) => toggleRuleInCollection(col.id, ruleId)}
                    />
                ))}
            </div>
        </section>
    );
}
