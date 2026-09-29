import React, { useMemo, useState } from 'react';
import SkillsGrid from './SkillsGrid';
import SkillFormModal from './SkillFormModal';
import { useSkills } from '../../hooks/useSkills';
import { toast } from '../shared/Toast';

export default function SkillsPanel({ user, onClose, activeSkillIds = [], onToggleSkill, agents = [] }) {
    const { skills, loading, error, refresh, create, update, remove } = useSkills();
    const [showForm, setShowForm] = useState(false);
    const [editingSkill, setEditingSkill] = useState(null);
    const [saving, setSaving] = useState(false);

    const attachedCountBySkillId = useMemo(() => {
        const counts = {};
        for (const agent of agents || []) {
            const ids = agent?.config?.attachedSkillIds;
            if (!Array.isArray(ids)) continue;
            for (const id of ids) counts[id] = (counts[id] || 0) + 1;
        }
        return counts;
    }, [agents]);

    const handleSave = async (form) => {
        setSaving(true);
        try {
            if (editingSkill) await update(editingSkill.id, form);
            else await create(form);
            setShowForm(false);
            setEditingSkill(null);
        } catch (err) {
            toast.error(err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id) => {
        try {
            await remove(id);
        } catch (err) {
            toast.error(err.message);
        }
    };

    return (
        <>
            <SkillsGrid
                user={user}
                skills={skills}
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
