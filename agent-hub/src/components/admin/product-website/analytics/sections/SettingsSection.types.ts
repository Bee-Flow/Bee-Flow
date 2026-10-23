import type { AnalyticsSite, AnalyticsResponse } from '../../analyticsApi';
import type React from 'react';

/** The tracker options mirrored onto the public script tag. */
export type TrackerSettings = { tag?: string; domains?: string; excludeHash?: boolean; excludeSearch?: boolean; doNotTrack?: boolean };

/** The session-recorder options. */
export type RecorderSettings = { sampleRate?: number; maskLevel?: string };

/** One row of the connection diagnostic. */
export type CheckItem = { id: string; status: string; label: string; detail?: string };

/** `/diagnose` response: the ordered checks. */
export type DiagnoseResponse = { checks?: CheckItem[] };

/** `/status` response: reachability and the URL split. */
export type StatusResponse = {
    reachable?: boolean; websiteCount?: number; publicUrl?: string; internalUrl?: string;
    error?: string; usingInternalOverride?: boolean;
};

/** Response of the recorder toggle. */
export type RecorderResponse = { upstreamWarning?: string };

export interface SettingsSectionProps {
    settings: {
        maskLevels?: string[];
        recorder?: RecorderSettings;
        tracker?: TrackerSettings; enabled?: boolean; configured?: boolean; consentMode?: string; url?: string
    } | null;
    sites?: AnalyticsSite[];
    onSaved: (res: AnalyticsResponse) => void;
    onSitesChanged: () => Promise<void>;
    onClose: (() => void) | null;
}

/** Sampling and masking for the session recorder. */
export interface RecorderCardProps {
    recorder: RecorderSettings;
    maskLevels?: string[];
    onChange: (arg0: string, l: string | number) => void;
}

/** Reachability + the internal/public URL split. */
export interface ConnectionCardProps {
    configured?: boolean;
}

/** Per-site tracking state + the session-recording opt-in. */
export interface SitesCardProps {
    sites: AnalyticsSite[];
    onChanged?: () => void;
}

export interface RowProps {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
}

export interface FieldProps {
    label: string;
    hint?: string;
    children?: React.ReactNode;
}

export interface ToggleProps {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}

export interface ModeChipProps {
    active: boolean;
    onClick: React.MouseEventHandler<HTMLButtonElement>;
    title: string;
    desc: string;
}
