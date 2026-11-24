import { useState, type ComponentType } from "react";
import { IconButton } from "@/components/ui/Button";
import { t } from "@/i18n";
import { usePlayer } from "@/player/store";

type DialogComponent = ComponentType<{ open: boolean; onOpenChange: (v: boolean) => void }>;

/**
 * Icon button that lazy-loads the karaoke video export dialog (and mediabunny)
 * only when clicked, keeping the encoder out of the main bundle.
 */
export function KaraokeExportButton() {
  const hasTrack = usePlayer((s) => !!s.current?.track);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [DialogComp, setDialogComp] = useState<DialogComponent | null>(null);

  const handleClick = async () => {
    if (!hasTrack || loading) return;
    if (DialogComp) {
      setOpen(true);
      return;
    }
    setLoading(true);
    try {
      const mod = await import("./ExportDialog");
      setDialogComp(() => mod.ExportDialog);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <IconButton
        icon={loading ? "loader" : "download"}
        label={t("karaokeVideo.button")}
        disabled={!hasTrack || loading}
        onClick={() => void handleClick()}
        className="!text-fg hover:bg-white/10"
      />
      {DialogComp && <DialogComp open={open} onOpenChange={setOpen} />}
    </>
  );
}

export default KaraokeExportButton;
