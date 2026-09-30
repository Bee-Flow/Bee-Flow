/**
 * Which of the drawer's conditional rows this session is offered — the web
 * Sidebar's conditions, as pure functions over a core/access snapshot so each
 * one is tested rather than trusted. (Studio's own rule, canSeeStudio, lives
 * with the Studio registry.)
 *
 * One deliberate difference: the web hides Studio, Forms, Notebooks and
 * Projects below its phone breakpoint (`isMobile`) because a phone-width
 * browser runs a simplified surface. This app IS the phone and carries those
 * natively, so only the person's own Simple Mode hides them here.
 */

import {
    can,
    canUse,
    evaluateGate,
    featureEnabled,
    hasLicenseFeature,
    holds,
    type AccessSnapshot,
} from '@/core/access';
import { passesGate, studioSection } from '@/features/studio';

/** `can('app_studio') && hasPermission('use_apps')` — and the group itself waits for a published app. */
export function offersApps(access: AccessSnapshot): boolean {
    return can(access, 'app_studio') && holds(access, 'use_apps');
}

/** canSeeForms (automations licence × programme) and use_forms. */
export function offersForms(access: AccessSnapshot): boolean {
    return hasLicenseFeature(access, 'automations') && canUse(access, 'automations') && holds(access, 'use_forms');
}

/** Not Simple Mode, the notebooks licence, both installation switches, and use_notebooks. */
export function offersNotebooks(access: AccessSnapshot): boolean {
    const gate = evaluateGate(
        { notSimpleMode: true, license: 'notebooks', flag: 'notebooks', perms: ['use_notebooks'] },
        access,
    );
    return gate.visible && !gate.locked && featureEnabled(access, 'notebooksMenu');
}

/** Not Simple Mode, the projects licence and switch — and the section waits for a project. */
export function offersProjects(access: AccessSnapshot): boolean {
    return !access.simpleMode && hasLicenseFeature(access, 'projects') && featureEnabled(access, 'projects');
}

/**
 * The Meeting Notes tab: Meeting Notes' capture flow, so that Studio section's gate —
 * the meeting_notes licence and programme and use_meeting_notes, exactly what
 * /api/transcriptions answers 403 without.
 */
export function offersRecord(access: AccessSnapshot): boolean {
    return passesGate(studioSection('meetingNotes'), access);
}
