/**
 * The organisation: its index of settings sections (model/sections.ts, the
 * web's order and gates), its record and the sections that edit it, its
 * Privacy Shield summary and data-subject requests. Import from
 * '@/features/org'. The org-* features (orgPeople, orgShield, orgUsage,
 * billing, compliance, orgIntegrations) build on `useOrgContext` and the
 * shared record hooks exported here; this feature never imports them.
 */

export { OrgLockedNotice, OrgLockedScreen, type OrgDenied } from './components/OrgLockedScreen';
export { OrgSettingsFrame, type FrameQuery } from './components/OrgSettingsFrame';
export { useDraft, type Draft } from './hooks/useDraft';
export { useSubmitDsrRequest, useUpdateOrganization } from './hooks/mutations';
export { useOrganization, useOrgGroups, useOrgMembers } from './hooks/queries';
export { useOrgContext, useOrgSections, type OrgContext } from './hooks/useOrgSections';
export { ChoiceGroup, type Choice } from './components/ChoiceGroup';
export { ORG_SECTIONS, orgSection, type OrgSection, type OrgSectionId } from './model/sections';
export type { OrgMember, Organization, OrgPatch, UserGroup } from './model/types';
export { OrgAcademyScreen } from './screens/OrgAcademyScreen';
export { OrgAiContextScreen } from './screens/OrgAiContextScreen';
export { OrgEncryptionScreen } from './screens/OrgEncryptionScreen';
export { OrgInfoScreen } from './screens/OrgInfoScreen';
export { OrgIntegrationCacheScreen } from './screens/OrgIntegrationCacheScreen';
export { OrgPrivacyScreen } from './screens/OrgPrivacyScreen';
export { OrgScreen } from './screens/OrgScreen';
export { OrgSignInScreen } from './screens/OrgSignInScreen';
export { OrgThemeScreen } from './screens/OrgThemeScreen';
