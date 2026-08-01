import { describe, it, expect } from 'vitest';
import { repairJamoRun } from './hangulJamoRepair';

// Simulates the broken-IME arrival pattern: each jamo lands as a bare
// character, and the repair runs after every insertion (as the input listener
// does).
function typeBroken(initial: string, jamos: string[]): string {
    let text = initial;
    let cursor = text.length;
    for (const j of jamos) {
        text = text.slice(0, cursor) + j + text.slice(cursor);
        cursor += 1;
        const r = repairJamoRun(text, cursor);
        if (r) {
            text = r.text;
            cursor = r.cursor;
        }
    }
    return text;
}

describe('repairJamoRun', () => {
    it('composes a full broken-IME sequence into syllables', () => {
        expect(typeBroken('', ['ㅇ', 'ㅣ', 'ㄹ', 'ㅓ', 'ㅎ', 'ㄱ', 'ㅔ'])).toBe('이렇게');
    });

    it('handles batchim attachment and rollover mid-stream', () => {
        expect(typeBroken('', ['ㄱ', 'ㅏ', 'ㅂ', 'ㅅ'])).toBe('값');
        expect(typeBroken('', ['ㅇ', 'ㅣ', 'ㅅ', 'ㅏ', 'ㅇ'])).toBe('이상');
    });

    it('attaches a bare jamo to a preceding composed syllable', () => {
        expect(typeBroken('이', ['ㄹ'])).toBe('일');
    });

    it('leaves consonant-only and vowel-only runs untouched (ㅋㅋㅋ, ㅠㅠ)', () => {
        expect(repairJamoRun('ㅋㅋㅋ', 3)).toBeNull();
        expect(repairJamoRun('ㅠㅠ', 2)).toBeNull();
    });

    it('returns null when there is no jamo at the cursor', () => {
        expect(repairJamoRun('hello', 5)).toBeNull();
        expect(repairJamoRun('이렇게', 3)).toBeNull();
        expect(repairJamoRun('', 0)).toBeNull();
    });

    it('repairs at a mid-text cursor without disturbing the tail', () => {
        const r = repairJamoRun('앞 ㅇㅣ 뒤', 4);
        expect(r).not.toBeNull();
        expect(r!.text).toBe('앞 이 뒤');
        expect(r!.cursor).toBe(3);
    });

    it('only rewrites the trailing run, not earlier jamo in the text', () => {
        const r = repairJamoRun('ㅋㅋ 그리고 ㅇㅣ', 9);
        expect(r).not.toBeNull();
        expect(r!.text).toBe('ㅋㅋ 그리고 이');
    });
});
