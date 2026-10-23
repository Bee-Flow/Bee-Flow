export interface PreferencesUser {
    simpleMode?: boolean;
    orgRole?: string | null;
    role?: string;
    displayName?: string;
    username?: string;
    email?: string;
    avatar?: string | null;
    avatarType?: string | null;
    featureFlags?: { projects?: boolean } | null;
}

export interface PreferencesAgent {
    id: string;
    name: string;
}

export interface PreferencesSectionProps {
    defaultAgentMode: string;
    setDefaultAgentMode: (mode: string) => void;
    defaultAgentId: string;
    setDefaultAgentId: (id: string) => void;
    agents: PreferencesAgent[];
    onLogout?: () => void;
    user?: PreferencesUser | null;
    onUpdateUser?: (patch: Partial<PreferencesUser>) => void;
}

export interface RowProps {
    label: string;
    description?: string;
    right: React.ReactNode;
    first?: boolean;
}

export interface DropdownOption {
    value: string;
    label: string;
}

export interface DropdownProps {
    value: string;
    options: DropdownOption[];
    onChange: (value: string) => void;
    ariaLabel?: string;
}

export interface ToggleProps {
    on: boolean;
    onClick: () => void;
    disabled?: boolean;
    ariaLabel?: string;
}

/** One row of GET /api/languages/user/locales. */
export interface UiLocale {
    code: string;
    name: string;
}
