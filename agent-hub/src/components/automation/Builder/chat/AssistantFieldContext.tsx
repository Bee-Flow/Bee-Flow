import { createContext, useContext } from 'react';

type AskAssistantField = (field: unknown) => unknown;

const AssistantFieldContext = createContext<AskAssistantField | null>(null);

export const AssistantFieldProvider = AssistantFieldContext.Provider;
export function useAssistantField() { return useContext(AssistantFieldContext); }
