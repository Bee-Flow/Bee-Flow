/**
 * useVoiceChatReady — the two-part gate that decides whether voice chat is
 * offered at all.
 *
 * Lifted out of VoiceCallButton when the composer's icon row collapsed into
 * ComposerToolsMenu: the menu needs the same answer, and duplicating a licence
 * check plus a server probe is exactly how the two drift apart. The button
 * still exists (agent chats and the Cowork composer render it), so both now
 * ask this hook rather than each keeping their own copy.
 *
 * Returns true only when BOTH hold:
 *   1. the user carries the `voice_chat` beta feature AND the licence allows it
 *      — defence in depth, since a stale session can still hold the beta flag
 *      on a community tier where every /ai/voice request would 403; and
 *   2. /ai/config reports `voiceChatReady` (a Mistral API key is configured).
 */

import { useVoiceChatConfigReady } from '@/api/queries/voiceChat';
import { useLicenseContext } from '../../licensing/LicenseContext';
import type { PermissionUser } from '@/hooks/usePermissionCheck';

/** The signed-in user, as far as the voice gate reads it. */
interface VoiceUser extends PermissionUser {
    betaFeatures?: string[];
}

export default function useVoiceChatReady(user: VoiceUser | null | undefined) {
    const { hasFeature: hasLicenseFeature } = useLicenseContext();

    const hasBetaFlag = !!(
        user?.isAdmin ||
        user?.permissions?.includes('all') ||
        (Array.isArray(user?.betaFeatures) && user.betaFeatures.includes('voice_chat'))
    ) && hasLicenseFeature('voice_chat');

    const { data: ready } = useVoiceChatConfigReady(hasBetaFlag);

    return !!(hasBetaFlag && ready);
}
