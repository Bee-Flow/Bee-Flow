/**
 * Every conversation in one list: direct chats and agent chats. Import from
 * '@/features/conversations'.
 *
 * Its own feature because it draws both kinds: agents build on the chat
 * feature, so an agent-aware list inside features/chat would make chat and
 * agents import each other.
 */

export { ConversationsScreen } from './screens/ConversationsScreen';
