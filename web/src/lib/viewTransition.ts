// Shared-element transition for the cover: the mini player's cover grows into
// the Now Playing cover (and back) with the View Transitions API. Browsers
// without it, or with reduced motion, just run the update.

import { flushSync } from "react-dom";

type VTDocument = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

export function withCoverTransition(update: () => void) {
  const doc = document as VTDocument;
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  const root = document.documentElement;
  root.classList.add("cover-vt"); // turns off the sheet slide while the cover morphs
  const vt = doc.startViewTransition(() => flushSync(update));
  vt.finished.finally(() => root.classList.remove("cover-vt"));
}

/** The view-transition-name both covers share (only one is on screen at a time). */
export const COVER_VT = "np-cover";
