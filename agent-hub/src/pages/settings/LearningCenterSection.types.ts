import type { SettingsUser } from './shell/settingsShellTypes';

/** An issued certificate as the drawer shows it . */
export interface CertificateRecord {
    certificateId: string;
    title?: string;
    level?: string | null;
    serial?: string;
    imageUrl?: string;
    pdfUrl?: string;
    verifyUrl?: string;
    linkedInUrl?: string;
    isPublic?: boolean;
}

export interface LearningCenterSectionProps {
    user: (SettingsUser & { id?: string }) | null | undefined;
}
