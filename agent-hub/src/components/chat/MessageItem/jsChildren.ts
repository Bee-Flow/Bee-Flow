import type { ComponentType } from 'react';
import AnswerChipsJs from './AnswerChips';
import ChatActivityJs from './ChatActivity';
import type { ChatMessage } from './messageTypes';
import ToolConfirmCardJs from './ToolConfirmCard';
import TokenisedBadgeJs from '../TokenisedBadge';

/**
 * The JavaScript children MessageItem's TypeScript pieces render, with the
 * props they are given. Their `= []` / `= null` defaults (and a JSDoc block
 * read as the props' type) would otherwise type those props as `never[]` or
 * `null` for a TypeScript caller.
 */

type Translate = (key: string, fallback?: string) => string;

export const ChatActivity = ChatActivityJs as unknown as ComponentType<{
    msg: ChatMessage;
    sessionSkills?: unknown[];
    t?: Translate | null;
}>;

export const ToolConfirmCard = ToolConfirmCardJs;

export const AnswerChips = AnswerChipsJs;

export const TokenisedBadge = TokenisedBadgeJs as unknown as ComponentType<{
    warnings?: unknown[];
    t?: Translate;
}>;
