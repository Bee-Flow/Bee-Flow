import Modal from '@/components/shared/Modal';
import useTranslation from '@/hooks/useTranslation';
import useUsage from '@/hooks/useUsage';
import { skillsApi } from '@/api/skillsApi';
import { SkillDangerZone, usageReading } from './SkillDetailParts';

/**
 * Deleting a skill from where people look for it: the ⋯ menu in the skill's
 * header and on its row in the list. Until now the only way was the bottom of
 * the Used-by tab, which nobody found.
 *
 * It is the SAME delete as that tab's (SkillDangerZone): the Used-by list is
 * shown first, the name is typed against it, and the first request goes out
 * WITHOUT confirmBreaking unless the list on screen was non-empty. The
 * server's 409 `in_use` answers with its own, fresher list, the card shows it
 * and asks for the name again, and only that second press confirms. Nothing
 * here skips the check.
 */
export interface SkillDeleteDialogProps {
    skill: { id: string; name?: string };
    currentUserId?: string | null;
    onClose: () => void;
    onDeleted: (id: string) => void;
    onNavigate?: ((to: string) => void) | null;
}

export default function SkillDeleteDialog({ skill, currentUserId = null, onClose, onDeleted, onNavigate = null }: SkillDeleteDialogProps) {
    const { t } = useTranslation();
    const { usage, unchecked, error } = useUsage('skill', skill.id);
    const { uncheckedKinds } = usageReading(usage, unchecked, error);
    const name = skill.name || t('skills_studio.untitled', 'Untitled skill');

    const remove = async (confirmBreaking: boolean) => {
        await skillsApi.remove(skill.id, confirmBreaking);
        onDeleted(skill.id);
    };

    return (
        <Modal
            open
            onClose={onClose}
            size="lg"
            disableBackdropClose
            title={t('skills_studio.delete_title', 'Delete skill')}
            description={name}
        >
            <SkillDangerZone
                name={name}
                usage={usage}
                usageError={error}
                uncheckedKinds={uncheckedKinds}
                currentUserId={currentUserId}
                onNavigate={onNavigate}
                onDelete={remove}
                onCancel={onClose}
            />
        </Modal>
    );
}
