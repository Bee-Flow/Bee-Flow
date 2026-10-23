import { useMemo, useState } from 'react';
import SkillsGrid from './SkillsGrid';
import SkillFormModal from './SkillFormModal';
import { useSkills, type SkillForm } from '../../hooks/useSkills';
import { toast } from '../shared/Toast';
import type { SkillRecord } from './SkillCard';

interface SkillsPanelProps {
    onClose?: () => void;
    activeSkillIds?: string[];
    onToggleSkill: (id: string) => void;
    user?: { id?: string; isAdmin?: boolean; organizationId?: string | null } | null;
    agents?: { config?: { attachedSkillIds?: unknown } | null }[];
}

export default function SkillsPanel({ user, onClose, activeSkillIds = [], onToggleSkill, agents = [] }: SkillsPanelProps) {
    const { skills, loading, error, refresh, create, update, remove } = useSkills();
    const [showForm, setShowForm] = useState(false);
    const [editingSkill, setEditingSkill] = useState<SkillRecord | null>(null);
    const [saving, setSaving] = useState(false);

    const attachedCountBySkillId = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const agent of agents || []) {
            const ids = agent?.config?.attachedSkillIds;
            if (!Array.isArray(ids)) continue;
            for (const id of ids) counts[id] = (counts[id] || 0) + 1;
        }
        return counts;
    }, [agents]);

    const handleSave = async (form: SkillForm) => {
        setSaving(true);
        try {
            if (editingSkill) await update(editingSkill.id, form);
            else await create(form);
            setShowForm(false);
            setEditingSkill(null);
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await remove(id);
        } catch (err) {
            toast.error((err as Error).message);
        }
    };

    return (
        <>
            <SkillsGrid
                user={user}
                skills={skills as SkillRecord[]}
                loading={loading}
                error={error}
                onRetry={refresh}
                onCreate={() => { setEditingSkill(null); setShowForm(true); }}
                onEdit={(skill) => { setEditingSkill(skill); setShowForm(true); }}
                onDelete={handleDelete}
                onClose={onClose}
                activeSkillIds={activeSkillIds}
                onToggleSkill={onToggleSkill}
                attachedCountBySkillId={attachedCountBySkillId}
            />

            {showForm && (
                <SkillFormModal
                    skill={editingSkill}
                    onSave={handleSave}
                    onCancel={() => { setShowForm(false); setEditingSkill(null); }}
                    saving={saving}
                    user={user}
                />
            )}
        </>
    );
}
