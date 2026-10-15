export type ConsentMode = 'cookieless' | 'cookies';

export interface TrackerSettings {
    tag?: string;
    domains?: string;
    excludeHash?: boolean;
    excludeSearch?: boolean;
    doNotTrack?: boolean;
}

export interface RecorderSettings {
    sampleRate?: number;
    maskLevel?: string;
}

/** The analytics settings the page is opened with. */
export interface AnalyticsSettings {
    enabled?: boolean;
    consentMode?: ConsentMode;
    url?: string;
    configured?: boolean;
    tracker?: TrackerSettings;
    recorder?: RecorderSettings;
    maskLevels?: string[];
}

/** One site of the install, as the sites list shows it. */
export interface SiteEntry {
    id: string;
    name?: string;
    websiteId?: string;
    tracked?: boolean;
    live?: boolean;
    recording?: boolean;
}

export interface SaveResponse {
    configured?: boolean;
}

export interface RecorderResponse {
    upstreamWarning?: string;
}

export interface DiagnoseCheck {
    id: string;
    status: string;
    label: string;
    detail?: string | null;
}

export interface DiagnoseResponse {
    checks?: DiagnoseCheck[];
}

export interface StatusResponse {
    reachable?: boolean;
    websiteCount?: number;
    publicUrl?: string | null;
    internalUrl?: string | null;
    error?: string | null;
    usingInternalOverride?: boolean;
}

export interface SettingsSectionProps {
    settings?: AnalyticsSettings | null;
    sites?: SiteEntry[];
    onSaved?: (res: SaveResponse) => void;
    onSitesChanged?: () => void;
    onClose?: () => void;
}
