// Keys pressed while an input method editor (Japanese, Chinese, Korean, ...)
// is composing belong to the IME: Enter commits the candidate, the arrows pick
// one. Safari fires `compositionend` BEFORE the keydown of that Enter, so
// `isComposing` is already false there; the keydown still carries keyCode 229.

interface KeyLike { nativeEvent?: { isComposing?: boolean } | null; keyCode?: number; key?: string }

/** True for any key the IME is handling. */
export function isImeKey(e: KeyLike): boolean {
    return !!e.nativeEvent?.isComposing || e.keyCode === 229;
}

/** True for the Enter that confirms an IME composition (it must not send, save or pick a mention). */
export function isImeEnter(e: KeyLike): boolean {
    return e.key === 'Enter' && isImeKey(e);
}
