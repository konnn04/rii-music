import { useEffect, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { SLEEP_CHOICES, setSleep, useSleep } from "@/player/sleep";
import { t, tn } from "@/i18n";
import { notify } from "./ui/Toast";
import { IconButton } from "./ui/Button";
import { Icon } from "./ui/Icon";

/** The timer state and its label ("Còn 12 phút", "Hết bài này" or "Hẹn giờ ngủ"). */
export function useSleepState() {
  const endsAt = useSleep((s) => s.endsAt);
  const endOfTrack = useSleep((s) => s.endOfTrack);
  const active = !!endsAt || endOfTrack;
  const left = useMinutesLeft(endsAt);
  const label = endOfTrack ? t("player.sleep.endOfTrackOn") : endsAt ? tn("player.sleep.left", left) : t("player.sleep.title");
  return { active, label, endOfTrack };
}

function pick(c: number | "track" | null) {
  setSleep(c);
  notify({
    icon: "moon",
    text: c === null ? t("player.sleep.off") : c === "track" ? t("player.sleep.endOfTrackOn") : tn("player.sleep.set", c),
  });
}

/** The stop choices, for a dropdown or a sub-menu. */
export function SleepItems({ Item }: { Item: typeof DropdownMenu.Item }) {
  const { active, endOfTrack } = useSleepState();
  return (
    <>
      {SLEEP_CHOICES.map((m) => (
        <Item key={m} className="menu-item" onSelect={() => pick(m)}>
          {tn("player.sleep.minutes", m)}
        </Item>
      ))}
      <Item className="menu-item" onSelect={() => pick("track")}>
        {endOfTrack && <Icon name="check" size={18} className="text-accent" />}
        {t("player.sleep.endOfTrack")}
      </Item>
      {active && (
        <Item className="menu-item text-danger" onSelect={() => pick(null)}>
          {t("player.sleep.cancel")}
        </Item>
      )}
    </>
  );
}

/** Hẹn giờ ngủ: moon button with the stop choices; lit while a timer runs. */
export function SleepButton({ size = 20, className = "" }: { size?: number; className?: string }) {
  const { active, label } = useSleepState();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <IconButton icon="moon" label={label} title={label} active={active} size={size} tooltip={false} className={className} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="menu-content z-[60]">
          <DropdownMenu.Label className="px-3 py-2 text-overline uppercase text-fg-muted">{active ? label : t("player.sleep.title")}</DropdownMenu.Label>
          <SleepItems Item={DropdownMenu.Item} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function useMinutesLeft(endsAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [endsAt]);
  return endsAt ? Math.max(1, Math.ceil((endsAt - now) / 60_000)) : 0;
}
