import type { SessionSkill } from './sessionSkillState';
import type React from 'react';

/**
 * SkillsPopover — composer-anchored popover that mirrors the Apps popover.
 *
 * Props:
 *   user                   — current user, for ownership checks on create
 *   activeSkillIds         — session-active skill IDs (toggled by user, capped)
 *   attachedSkillIds       — IDs attached to the selected agent (locked on)
 *   onToggleSkill(id)      — toggle an id in activeSkillIds
 *   buttonClassName        — override for trigger button class (default matches Apps button)
 *   open / onOpenChange    — optional controlled mode; the chat composer opens
 *                            this from a ComposerToolsMenu row instead of a
 *                            loose icon, and hides the trigger with hideTrigger.
 *                            The popover still anchors here, in the composer row.
 *   hideTrigger            — render the popover without its own button
 */
export type SessionSkillView = SessionSkill & { name?: string; description?: string; order?: number; instructions?: string; workflow?: string; rules?: string; examples?: string };

export interface SkillsPopoverProps {
    user?: { id?: string | number; organizationId?: string | null } | null;
    activeSkillIds?: string[];
    directSessionSkills?: SessionSkillView[];
    attachedSkillIds?: string[];
    directMode?: boolean;
    directConversationId?: string | null;
    directActivatedSessionSkillIds?: string[];
    onToggleSkill?: (value: string) => void;
    buttonClassName?: string;
    open: boolean;
    onOpenChange: React.Dispatch<React.SetStateAction<boolean>>;
    hideTrigger?: boolean;
}
