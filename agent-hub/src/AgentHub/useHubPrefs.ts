import { useCallback, useState } from 'react';
import scopedStorage from '../utils/scopedStorage';

/**
 * The chat preferences kept per user in local storage: the history mode
 * ("per-agent" or "all-chats") and the skills switched on for chats. They
 * hydrate once the user id is known.
 */
export default function useHubPrefs(userId: string | undefined) {
    const [chatHistoryMode, setChatHistoryMode] = useState('per-agent');
    const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
    // Hydrate from local storage once the user id is known (and again if it
    // changes), while rendering rather than in an effect: the stored values are
    // on the first painted frame. React fires child effects before the shell's,
    // so setCurrentUser has not run yet; setting it here is idempotent.
    const [hydratedFor, setHydratedFor] = useState<string | undefined>(undefined);
    if (userId && userId !== hydratedFor) {
        setHydratedFor(userId);
        scopedStorage.setCurrentUser(userId);
        const storedMode = scopedStorage.getItem('chatHistoryMode');
        if (storedMode) setChatHistoryMode(storedMode);
        const storedSkills = scopedStorage.getJSON<string[]>('activeSkillIds', null);
        if (Array.isArray(storedSkills)) setActiveSkillIds(storedSkills);
    }

    // Toggle one skill for chats (at most five at a time) and remember the choice.
    const handleToggleSkill = useCallback((skillId: string) => {
        setActiveSkillIds(prev => {
            const next = prev.includes(skillId)
                ? prev.filter(id => id !== skillId)
                : [...prev.slice(0, 4), skillId]; // max 5
            scopedStorage.setJSON('activeSkillIds', next);
            return next;
        });
    }, []);

    return { chatHistoryMode, setChatHistoryMode, activeSkillIds, setActiveSkillIds, handleToggleSkill };
}
