/**
 * Skills: reusable instruction packs — the library, one skill's Studio editor
 * (method, examples, test, used by), and which are switched on for the next
 * chat turn (the composer reads that store). Import from '@/features/skills'.
 */

export { SkillScreen } from './screens/SkillScreen';
export { SkillsScreen } from './screens/SkillsScreen';

export { useSkills } from './hooks/queries';
export { retainExistingSkills, useActiveSkills } from './model/active';
export { ACTIVE_SKILL_CAP, type Skill } from './model/types';
