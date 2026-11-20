import { useState } from "react";
import { useFx } from "@/player/fx";
import { t } from "@/i18n";
import { IconButton, Button } from "./ui/Button";
import { SoundDialog } from "./SoundDialog";

/** Opens the sound settings (EQ, exciter, crossfeed…); lit while effects are on. */
export function SoundButton({ size = 20, className = "", variant = "icon" }: { size?: number; className?: string; variant?: "icon" | "button" }) {
  const [open, setOpen] = useState(false);
  const on = useFx((s) => s.enabled);
  return (
    <>
      {variant === "icon" ? (
        <IconButton icon="sliders" label={t("sound.title")} active={on} size={size} className={className} onClick={() => setOpen(true)} />
      ) : (
        <Button icon="sliders" onClick={() => setOpen(true)}>
          {t("sound.title")}
        </Button>
      )}
      {open && <SoundDialog open onClose={() => setOpen(false)} />}
    </>
  );
}
