/**
 * What this APK is, for a bug report: version and build from the native
 * layer, profile and commit from `Constants.expoConfig.extra` (stamped by
 * app.config.ts from BEEFLOW_BUILD_PROFILE / BEEFLOW_COMMIT_SHA at build time).
 */

import * as Application from 'expo-application';
import Constants from 'expo-constants';

import { MIN_SERVER_BUILD, type ServerSupport } from '@/core/api/server';
import { translate } from '@/core/i18n';

interface BuildExtra {
    buildProfile?: string;
    commitSha?: string;
    defaultServerUrl?: string;
}

export interface BuildInfo {
    version: string;
    build: string;
    /** The full commit, or '' when the build was not stamped. */
    commitSha: string;
    /** Seven characters, or 'not stamped'. */
    sha: string;
    profile: string;
    /** The server this APK was built to point at, or ''. */
    defaultServerUrl: string;
}

export function buildInfo(): BuildInfo {
    const extra = (Constants.expoConfig?.extra ?? {}) as BuildExtra;
    return {
        version: Constants.expoConfig?.version ?? Application.nativeApplicationVersion ?? '—',
        build: Application.nativeBuildVersion ?? '—',
        commitSha: extra.commitSha ?? '',
        sha: extra.commitSha ? extra.commitSha.slice(0, 7) : 'not stamped',
        profile: extra.buildProfile ?? 'development',
        defaultServerUrl: String(extra.defaultServerUrl ?? ''),
    };
}

/** The capability probe's verdict, in words. */
export function supportLabel(support: ServerSupport | null | undefined): string {
    if (support?.level === 'ok') {
        return translate('mobile.settings.compat_ok', 'Compatible (needs {min} or later)', { min: MIN_SERVER_BUILD });
    }
    if (support?.level === 'outdated') {
        return translate('mobile.settings.compat_outdated', 'Older than {min}', { min: MIN_SERVER_BUILD });
    }
    return translate('mobile.settings.compat_unknown', 'Not determined');
}

/**
 * One block, formatted for pasting into a support thread. It stays English on
 * purpose: whoever reads it is a support engineer, not the person who copied it.
 */
export function versionDetails(
    info: BuildInfo,
    server: string | null,
    serverSha: string | undefined,
    compatibility: string,
): string {
    return [
        `Bee Flow for Android ${info.version} (build ${info.build})`,
        `profile: ${info.profile}`,
        `app sha: ${info.commitSha || 'not stamped'}`,
        `server: ${server ?? 'not configured'}`,
        `server sha: ${serverSha || 'not reported'}`,
        `server compatibility: ${compatibility} (app needs a server built ${MIN_SERVER_BUILD} or later)`,
        `android: ${Application.applicationId ?? 'nl.beeflow.app'}`,
    ].join('\n');
}
