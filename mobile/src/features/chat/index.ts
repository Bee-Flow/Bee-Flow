/**
 * The chat feature's public surface. Import from '@/features/chat', never
 * from its internals.
 *
 * The screens are what app/ renders. Other features use the pieces every chat
 * surface shares — the composer, the transcript, the live turn's notices, the
 * DLP answer, the message reader — so an agent chat and a notebook chat look
 * and behave like the direct one. The list of every conversation
 * (features/conversations) reads the direct chats through useConversations,
 * and both it and the drawer (features/shell) rename, pin and delete them
 * through ChatActions, on the same mutations the details screen uses.
 */

export { readMessage } from './api/readers';
export { ChatActions, type ChatActionsProps } from './components/ChatActions';
export { ChatTranscript, type ChatTranscriptProps } from './components/transcript/ChatTranscript';
export { Composer, type ComposerProps } from './components/composer/Composer';
export { MessageBubble, type MessageBubbleProps } from './components/message/MessageBubble';
export { TurnNotices, type TurnNoticesProps } from './components/transcript/TurnNotices';
export { dlpResolverFor, type DlpChoice, type DlpResolver } from './hooks/dlpResolver';
export type { TranscriptActions, ToolDecision } from './hooks/transcriptActions';
export { useLatest } from './hooks/useLatest';
export { useDeleteConversation, usePatchConversation } from './hooks/mutations';
export { useConversations, useTiers } from './hooks/queries';
export { useLocalTranscript, type LocalTranscriptOptions } from './hooks/useLocalTranscript';
export { useTranscriptTurns, type StartTurn, type TranscriptTurnsOptions, type TurnOptions } from './hooks/useTranscriptTurns';
export { encodeAttachments, toWire } from './model/attachments';
export type { Attachment, ChatMessage, ComposerSettings, ConversationSummary } from './model/types';
export { ChatDetailsScreen } from './screens/ChatDetailsScreen';
export { ChatHomeScreen } from './screens/ChatHomeScreen';
export { ChatScreen, type ChatScreenProps } from './screens/ChatScreen';
