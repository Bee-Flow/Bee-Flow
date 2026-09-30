/**
 * The version block every support thread would otherwise have to ask for, and
 * nobody knows off the top of their head.
 */

import * as Application from 'expo-application';
import Constants from 'expo-constants';

import { getServerUrl } from '@/core/api/server';

export function diagnostics(serverVersion: string | undefined): string {
    const extra = (Constants.expoConfig?.extra ?? {}) as { commitSha?: string; buildProfile?: string };
    return [
        `App: ${Constants.expoConfig?.version ?? '?'} (${Application.nativeBuildVersion ?? '?'})`,
        `Profile: ${extra.buildProfile ?? 'development'}`,
        `App commit: ${extra.commitSha || 'not stamped'}`,
        `Server: ${getServerUrl() ?? 'not configured'}`,
        `Server commit: ${serverVersion || 'not reported'}`,
        'Client: Bee Flow for Android',
    ].join('\n');
}
