/**
 * The search feature's public surface. Import from '@/features/search', never
 * from its internals. The share-intent handoff is here too: a file shared into
 * the app is staged by ShareIntentGate and picked up by the chat composer.
 */

export { ShareIntentGate } from './components/ShareIntentGate';
export { SearchScreen } from './screens/SearchScreen';
export {
    consumePendingShare,
    describeSharedPayload,
    hasPendingShare,
    usePendingShare,
    type SharedFile,
    type SharedPayload,
} from './model/shareIntent';
