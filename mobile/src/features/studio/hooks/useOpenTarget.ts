/**
 * Open a Studio destination. Every one is a screen of this app
 * (model/links.ts); a tab (/studio, /record) is switched to rather than
 * stacked as a second copy of the drawer (openRoute).
 */

import { useRouter } from 'expo-router';

import { openRoute } from '@/shared/navigation';

import type { OpenTarget } from '../model/links';

export function useOpenTarget(): (target: OpenTarget) => void {
    const router = useRouter();
    return (target) => openRoute(router, target.href);
}
