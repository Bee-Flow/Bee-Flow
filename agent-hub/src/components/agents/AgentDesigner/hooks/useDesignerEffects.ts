import { useEffect } from 'react';
import type { RefObject } from 'react';
import { TOUR_OPEN_DESIGNER_SECTION } from '@/components/onboarding/tourSteps';

const KNOWN_SECTIONS = new Set(['identity', 'knowledge', 'tools', 'behavior']);

/**
 * The Agent Designer's window listeners. Split out of AgentDesigner/index.jsx
 * without a change in behaviour.
 *
 * Learning Center tours: when a lesson spotlights an anchor that only renders
 * in a specific Designer section (the system prompt, tools, or knowledge), the
 * tour engine asks us to open that section first so the anchor exists. And
 * the emoji picker closes on a click outside it.
 */
export default function useDesignerEffects({ setActiveSection, showEmojiPicker, setShowEmojiPicker, emojiPickerRef }: {
    setActiveSection: (section: string) => void;
    showEmojiPicker: boolean;
    setShowEmojiPicker: (open: boolean) => void;
    emojiPickerRef: RefObject<HTMLElement | null>;
}) {
    useEffect(() => {
        const onOpenSection = (e: Event) => {
            const section = (e as CustomEvent<{ section?: string }>)?.detail?.section;
            if (section && KNOWN_SECTIONS.has(section)) setActiveSection(section);
        };
        window.addEventListener(TOUR_OPEN_DESIGNER_SECTION, onOpenSection);
        return () => window.removeEventListener(TOUR_OPEN_DESIGNER_SECTION, onOpenSection);
    }, [setActiveSection]);

    useEffect(() => {
        if (!showEmojiPicker) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
                setShowEmojiPicker(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [showEmojiPicker, setShowEmojiPicker, emojiPickerRef]);
}
