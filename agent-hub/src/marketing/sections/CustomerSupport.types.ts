export interface Convo { threadId: string; accessToken: string; subject: string; threadUrl: string | null }

export interface SupportThread { status?: string; subject?: string }

export interface SupportMessage { id: string | number; author_kind?: string; author_display?: string; created_at?: string; body?: string }
