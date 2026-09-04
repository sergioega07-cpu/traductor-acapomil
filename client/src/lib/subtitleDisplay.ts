import { useEffect, useMemo, useState } from 'react';
import { isValidTranslationText, textsLookIdentical } from './tts';

export type SubtitleDisplayState = {
  /** Text shown above (source), or empty when identical pending short window */
  originalLine: string;
  /** Large caption line */
  largeText: string;
  /** Brief "traduciendo…" badge (not the permanent large placeholder) */
  showTranslatingBadge: boolean;
  /** True while waiting for a real distinct translation */
  pending: boolean;
  /** True when we have a usable distinct translation */
  hasRealTranslation: boolean;
};

/**
 * Avoid permanent stuck "traduciendo…":
 * - While translation empty, invalid ("es"), or === original: brief pending state
 * - After waitMs: show original large; badge only briefly then hide
 * - When translation differs and is valid: show it large, original small above
 */
export function useSubtitleDisplay(
  original: string,
  translation: string,
  waitMs = 1500
): SubtitleDisplayState {
  const orig = original.trim();
  const rawTrad = translation.trim();
  const trad = isValidTranslationText(rawTrad) ? rawTrad : '';
  const identical = Boolean(orig) && Boolean(trad) && textsLookIdentical(orig, trad);
  const pending = Boolean(orig) && (!trad || identical);
  const hasRealTranslation = Boolean(trad) && !identical;

  const [pastWait, setPastWait] = useState(false);
  const [showBadge, setShowBadge] = useState(false);

  useEffect(() => {
    if (!pending) {
      setPastWait(false);
      setShowBadge(false);
      return;
    }
    setPastWait(false);
    setShowBadge(true);
    const tWait = window.setTimeout(() => setPastWait(true), waitMs);
    const tBadge = window.setTimeout(() => setShowBadge(false), waitMs + 900);
    return () => {
      window.clearTimeout(tWait);
      window.clearTimeout(tBadge);
    };
  }, [orig, trad, pending, waitMs]);

  return useMemo(() => {
    if (!orig && !trad) {
      return {
        originalLine: '',
        largeText: '',
        showTranslatingBadge: false,
        pending: false,
        hasRealTranslation: false,
      };
    }

    if (hasRealTranslation) {
      return {
        originalLine: orig,
        largeText: trad,
        showTranslatingBadge: false,
        pending: false,
        hasRealTranslation: true,
      };
    }

    // Pending: empty, invalid, or identical translation — never show "es" large
    if (pastWait) {
      return {
        originalLine: '',
        largeText: orig || '…',
        showTranslatingBadge: showBadge,
        pending: true,
        hasRealTranslation: false,
      };
    }

    return {
      originalLine: orig,
      largeText: 'traduciendo…',
      showTranslatingBadge: true,
      pending: true,
      hasRealTranslation: false,
    };
  }, [orig, trad, hasRealTranslation, pastWait, showBadge]);
}
