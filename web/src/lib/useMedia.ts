import { useSyncExternalStore } from "react";

function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
  );
}

/** < 768 px */
export const useIsMobile = () => useMedia("(max-width: 767.98px)");
/** ≥ 1024 px */
export const useIsDesktop = () => useMedia("(min-width: 1024px)");
export const useCanHover = () => useMedia("(hover: hover) and (pointer: fine)");
