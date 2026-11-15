import OrgHealthBanner from '../OrgHealthBanner';

interface UsersOrgControlsProps {
    /** A platform admin has "All organisations" chosen. */
    needsChoice: boolean;
    /** The organisation is the viewer's home organisation (the connector health is read for that one only). */
    homeOrg: boolean;
}

/**
 * Above the people: the connector-health blockers of the viewer's own organisation. Auto-approving
 * people from the organisation's domains is a sign-in setting: the Preferred sign-in method row
 * (orgInfo/OrgAuthSection) is its one home.
 */
export default function UsersOrgControls({ needsChoice, homeOrg }: UsersOrgControlsProps) {
    return !needsChoice && homeOrg ? <OrgHealthBanner /> : null;
}
