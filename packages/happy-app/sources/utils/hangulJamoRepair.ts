/**
 * Self-healing fallback for a broken macOS IME (observed on Chrome 151 ×
 * macOS 26.6 PWA windows): the OS stops composing Hangul and each keystroke
 * commits a bare compatibility jamo via a plain `insertText` — the user sees
 * "ㅇㅣㄹㅓㅎㄱㅔ" instead of "이렇게". A healthy IME only ever inserts through
 * composition events (`insertCompositionText`), so a single-jamo `insertText`
 * outside composition is a reliable breakage signature.
 *
 * On that signature we re-run the 두벌식 automaton (hangul-js) over the jamo
 * run at the cursor — including at most one preceding composed syllable so
 * batchim attachment and rollover work (이+ㄹ→일, 일+ㅓ→이러) — and replace it
 * in place. Identity runs (ㅋㅋㅋ, ㅠㅠ) are untouched, and the repair never
 * runs while a real composition is active.
 */
import * as Hangul from 'hangul-js';

const COMPAT_JAMO = /^[ㄱ-ㅣ]$/;
const isJamo = (ch: string) => COMPAT_JAMO.test(ch);
const isSyllable = (ch: string) => ch >= '가' && ch <= '힣';

// Bound the rescan window; a jamo run longer than this cannot change its
// leading syllables anyway.
const MAX_RUN = 12;

export function repairJamoRun(text: string, cursor: number): { text: string; cursor: number } | null {
    let start = cursor;
    while (start > 0 && cursor - start < MAX_RUN && isJamo(text[start - 1])) {
        start--;
    }
    if (start === cursor) return null;
    if (start > 0 && isSyllable(text[start - 1])) {
        start--;
    }
    const span = text.slice(start, cursor);
    const composed = Hangul.assemble(Hangul.disassemble(span));
    if (composed === span) return null;
    return {
        text: text.slice(0, start) + composed + text.slice(cursor),
        cursor: start + composed.length,
    };
}

export function installJamoRepair(el: HTMLTextAreaElement): () => void {
    let composing = false;
    let announced = false;

    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; };

    const onInput = (e: Event) => {
        if (composing) return;
        const ie = e as InputEvent;
        if (ie.inputType !== 'insertText' || !ie.data || !isJamo(ie.data)) return;
        const cursor = el.selectionStart ?? el.value.length;
        const repair = repairJamoRun(el.value, cursor);
        if (!repair) return;
        if (!announced) {
            announced = true;
            console.info('[hangul-repair] broken IME composition detected (bare-jamo insertText) — composing in-app');
        }
        // Write through the prototype setter so React's value tracker sees the
        // change and the re-dispatched input event reaches onChange handlers.
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return;
        setter.call(el, repair.text);
        el.setSelectionRange(repair.cursor, repair.cursor);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    el.addEventListener('compositionstart', onCompositionStart);
    el.addEventListener('compositionend', onCompositionEnd);
    el.addEventListener('input', onInput);
    return () => {
        el.removeEventListener('compositionstart', onCompositionStart);
        el.removeEventListener('compositionend', onCompositionEnd);
        el.removeEventListener('input', onInput);
    };
}
