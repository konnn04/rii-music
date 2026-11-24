import { activeIndex, type Line } from "@/components/layout/LyricsView";
import { coverUrl, type Track } from "@/lib/api";
import { fmtTime } from "@/lib/format";

export type Resolution = "720p" | "1080p";

export const RESOLUTIONS: Record<Resolution, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};

const FONT_FAMILY = "'Be Vietnam Pro', system-ui, -apple-system, sans-serif";

export async function loadCanvasFonts(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  try {
    await Promise.all([
      document.fonts.load("700 48px 'Be Vietnam Pro'"),
      document.fonts.load("600 32px 'Be Vietnam Pro'"),
      document.fonts.load("400 24px 'Be Vietnam Pro'"),
    ]);
  } catch {
    /* Fallback to system font if webfont fails */
  }
}

export async function loadCoverBitmap(
  trackId: string,
  hasCover: boolean,
  signal?: AbortSignal,
): Promise<ImageBitmap | null> {
  if (!hasCover) return null;
  try {
    const res = await fetch(coverUrl(trackId), { credentials: "include", signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}

function resolveAccentColor(): string {
  const fallback = "#8b7bff";
  if (typeof document === "undefined") return fallback;
  try {
    const raw =
      getComputedStyle(document.documentElement).getPropertyValue("--np-accent").trim() ||
      getComputedStyle(document.documentElement).getPropertyValue("--vg-accent").trim();
    if (!raw) return fallback;
    // Validate and convert to a concrete RGB color via a tiny probe canvas
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const pctx = probe.getContext("2d");
    if (!pctx) return fallback;
    pctx.fillStyle = fallback;
    pctx.fillStyle = raw;
    return typeof pctx.fillStyle === "string" && pctx.fillStyle ? pctx.fillStyle : fallback;
  } catch {
    return fallback;
  }
}

function hexOrRgbWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    if (full.length === 6) {
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
    }
  }
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a.toFixed(3)})`;
  return `rgba(139, 123, 255, ${a.toFixed(3)})`;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}

/** Word-wrap text into lines that fit `maxWidth`, breaking long words if needed. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const rows: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      rows.push(current);
      current = "";
    }
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
    } else {
      // Break an overly long single token character-by-character
      let chunk = "";
      for (const ch of word) {
        if (chunk && ctx.measureText(chunk + ch).width > maxWidth) {
          rows.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      current = chunk;
    }
  }
  if (current) rows.push(current);
  return rows;
}

/** Truncate a single line with an ellipsis so it fits `maxWidth`. */
function truncateLine(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ell = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + ell;
}

/**
 * Fit text into at most `maxRows` lines by stepping down font size from `maxFont` to `minFont`.
 */
function fitWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxRows: number,
  maxFont: number,
  minFont: number,
  weight: number,
): { fontSize: number; rows: string[] } {
  const step = Math.max(2, Math.round((maxFont - minFont) / 8));
  let fontSize = maxFont;
  let rows: string[] = [];

  while (fontSize >= minFont) {
    ctx.font = `${weight} ${fontSize}px ${FONT_FAMILY}`;
    rows = wrapText(ctx, text, maxWidth);
    if (rows.length <= maxRows) {
      return { fontSize, rows };
    }
    fontSize -= step;
  }

  ctx.font = `${weight} ${minFont}px ${FONT_FAMILY}`;
  rows = wrapText(ctx, text, maxWidth);
  if (rows.length > maxRows) {
    const kept = rows.slice(0, maxRows);
    kept[maxRows - 1] = truncateLine(ctx, kept[maxRows - 1], maxWidth);
    return { fontSize: minFont, rows: kept };
  }
  return { fontSize: minFont, rows };
}

export type FrameRendererOptions = {
  width: number;
  height: number;
  track: Track;
  cover: ImageBitmap | null;
  duration: number;
  beatEnvelope: Float32Array;
  showLyrics: boolean;
  lines: Line[];
  offsetMs: number;
};

export class KaraokeFrameRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bgCanvas: HTMLCanvasElement;
  private width: number;
  private height: number;
  private scale: number;
  private track: Track;
  private cover: ImageBitmap | null;
  private duration: number;
  private beatEnvelope: Float32Array;
  private showLyrics: boolean;
  private lines: Line[];
  private offsetSec: number;
  private accent: string;

  constructor(opts: FrameRendererOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.scale = opts.height / 720; // 1.0 at 720p, 1.5 at 1080p
    this.track = opts.track;
    this.cover = opts.cover;
    this.duration = Math.max(0.001, opts.duration);
    this.beatEnvelope = opts.beatEnvelope;
    this.showLyrics = opts.showLyrics && opts.lines.length > 0;
    this.lines = opts.lines;
    this.offsetSec = opts.offsetMs / 1000;
    this.accent = resolveAccentColor();

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;

    this.bgCanvas = this.buildBackground();
  }

  /** Pre-render the blurred, darkened cover background once for fast frame rendering. */
  private buildBackground(): HTMLCanvasElement {
    const bg = document.createElement("canvas");
    bg.width = this.width;
    bg.height = this.height;
    const bctx = bg.getContext("2d");
    if (!bctx) return bg;

    if (this.cover) {
      bctx.fillStyle = "#0a0b10";
      bctx.fillRect(0, 0, this.width, this.height);

      // Overscale the cover so the blur edges stay outside the frame
      const margin = Math.round(96 * this.scale);
      const targetW = this.width + margin * 2;
      const targetH = this.height + margin * 2;
      const imgAspect = this.cover.width / Math.max(1, this.cover.height);
      const boxAspect = targetW / targetH;
      let drawW = targetW;
      let drawH = targetH;
      if (imgAspect > boxAspect) {
        drawW = targetH * imgAspect;
      } else {
        drawH = targetW / imgAspect;
      }
      const dx = (this.width - drawW) / 2;
      const dy = (this.height - drawH) / 2;

      bctx.save();
      bctx.filter = `blur(${Math.round(40 * this.scale)}px)`;
      bctx.drawImage(this.cover, dx, dy, drawW, drawH);
      bctx.restore();

      // Darken for high lyric contrast
      bctx.fillStyle = "rgba(8, 9, 14, 0.62)";
      bctx.fillRect(0, 0, this.width, this.height);
    } else {
      const grad = bctx.createLinearGradient(0, 0, this.width, this.height);
      grad.addColorStop(0, "#141625");
      grad.addColorStop(0.5, "#0d0f18");
      grad.addColorStop(1, "#090a10");
      bctx.fillStyle = grad;
      bctx.fillRect(0, 0, this.width, this.height);
    }

    // Subtle radial vignette
    const vig = bctx.createRadialGradient(
      this.width * 0.5,
      this.height * 0.45,
      this.height * 0.15,
      this.width * 0.5,
      this.height * 0.5,
      this.width * 0.72,
    );
    vig.addColorStop(0, "rgba(0, 0, 0, 0)");
    vig.addColorStop(1, "rgba(0, 0, 0, 0.48)");
    bctx.fillStyle = vig;
    bctx.fillRect(0, 0, this.width, this.height);

    return bg;
  }

  drawFrame(timeSec: number, frameIndex: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const beat = this.beatEnvelope[frameIndex] ?? 0;

    // 1. Background
    ctx.drawImage(this.bgCanvas, 0, 0);

    // 2. Beat-reactive accent glow & subtle brightness flash on strong beats
    if (beat > 0.02) {
      const glowCx = this.showLyrics ? this.width * 0.24 : this.width * 0.5;
      const glowCy = this.showLyrics ? this.height * 0.41 : this.height * 0.39;
      const glowR = (270 + beat * 90) * s;
      const glow = ctx.createRadialGradient(glowCx, glowCy, 0, glowCx, glowCy, glowR);
      glow.addColorStop(0, hexOrRgbWithAlpha(this.accent, 0.14 + beat * 0.22));
      glow.addColorStop(0.6, hexOrRgbWithAlpha(this.accent, beat * 0.07));
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, this.width, this.height);

      if (beat > 0.55) {
        const flashAlpha = ((beat - 0.55) / 0.45) * 0.075;
        ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha.toFixed(4)})`;
        ctx.fillRect(0, 0, this.width, this.height);
      }
    }

    if (this.showLyrics) {
      this.drawLeftPanel(beat);
      this.drawLyricsPanel(timeSec);
    } else {
      this.drawCenteredPanel(beat);
    }

    this.drawBottomBar(timeSec);
  }

  private drawCoverArt(cx: number, cy: number, baseSize: number, beat: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const pulse = 1 + beat * 0.04; // 1.0 - 1.04
    const size = baseSize * pulse;
    const x = cx - size / 2;
    const y = cy - size / 2;
    const radius = 20 * s;

    ctx.save();
    ctx.shadowColor = beat > 0.5 ? hexOrRgbWithAlpha(this.accent, 0.45) : "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = (34 + beat * 20) * s;
    ctx.shadowOffsetY = 14 * s;
    drawRoundedRect(ctx, x, y, size, size, radius);
    ctx.fillStyle = "#181a24";
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, x, y, size, size, radius);
    ctx.clip();
    if (this.cover) {
      const iw = this.cover.width;
      const ih = this.cover.height;
      const side = Math.min(iw, ih);
      const sx = (iw - side) / 2;
      const sy = (ih - side) / 2;
      ctx.drawImage(this.cover, sx, sy, side, side, x, y, size, size);
    } else {
      const grad = ctx.createLinearGradient(x, y, x + size, y + size);
      grad.addColorStop(0, "#24283b");
      grad.addColorStop(1, "#141724");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, size, size);

      ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
      ctx.font = `700 ${Math.round(size * 0.36)}px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("♪", cx, cy + 4 * s);
    }
    ctx.restore();

    // Crisp subtle border around cover
    ctx.save();
    drawRoundedRect(ctx, x, y, size, size, radius);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.stroke();
    ctx.restore();
  }

  private drawTrackMeta(cx: number, topY: number, maxWidth: number, align: CanvasTextAlign): void {
    const ctx = this.ctx;
    const s = this.scale;

    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = "top";

    // Title (up to 2 lines)
    const { fontSize: titleSize, rows: titleRows } = fitWrappedText(
      ctx,
      this.track.title,
      maxWidth,
      2,
      Math.round(28 * s),
      Math.round(20 * s),
      700,
    );
    ctx.font = `700 ${titleSize}px ${FONT_FAMILY}`;
    ctx.fillStyle = "#f5f6fa";
    const lineH = Math.round(titleSize * 1.26);
    let y = topY;
    for (const row of titleRows) {
      ctx.fillText(row, cx, y);
      y += lineH;
    }

    // Artist (single line, muted)
    const artistSize = Math.round(19 * s);
    ctx.font = `500 ${artistSize}px ${FONT_FAMILY}`;
    ctx.fillStyle = "rgba(242, 243, 245, 0.68)";
    const artistText = truncateLine(ctx, this.track.artist || "", maxWidth);
    if (artistText) {
      ctx.fillText(artistText, cx, y + Math.round(6 * s));
    }
    ctx.restore();
  }

  private drawLeftPanel(beat: number): void {
    const s = this.scale;
    const panelLeft = 72 * s;
    const coverSize = 316 * s;
    const cx = panelLeft + coverSize / 2;
    const cy = this.height * 0.39;

    this.drawCoverArt(cx, cy, coverSize, beat);
    this.drawTrackMeta(panelLeft, cy + coverSize / 2 + 28 * s, coverSize + 16 * s, "left");
  }

  private drawCenteredPanel(beat: number): void {
    const s = this.scale;
    const coverSize = 340 * s;
    const cx = this.width / 2;
    const cy = this.height * 0.39;

    this.drawCoverArt(cx, cy, coverSize, beat);
    this.drawTrackMeta(cx, cy + coverSize / 2 + 28 * s, Math.round(this.width * 0.65), "center");
  }

  private drawLyricsPanel(timeSec: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const panelLeft = 456 * s;
    const panelRight = this.width - 72 * s;
    const maxWidth = panelRight - panelLeft;
    const centerX = (panelLeft + panelRight) / 2;
    const centerY = this.height * 0.455;

    const at = timeSec + this.offsetSec;
    const idx = activeIndex(this.lines, at);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (idx < 0) {
      // Before first line: 3-2-1 countdown when < 4 s away
      const first = this.lines[0];
      const until = first.t - at;
      if (until > 0 && until < 4) {
        const count = Math.min(3, Math.max(1, Math.ceil(until)));
        const frac = until - Math.floor(until);
        const popScale = 1 + Math.max(0, frac - 0.65) * 0.35;

        ctx.save();
        ctx.translate(centerX, centerY - 26 * s);
        ctx.scale(popScale, popScale);
        ctx.font = `700 ${Math.round(88 * s)}px ${FONT_FAMILY}`;
        ctx.fillStyle = this.accent;
        ctx.shadowColor = hexOrRgbWithAlpha(this.accent, 0.55);
        ctx.shadowBlur = 28 * s;
        ctx.fillText(String(count), 0, 0);
        ctx.restore();

        // 3 indicator dots
        const dotR = 8 * s;
        const dotGap = 32 * s;
        const dotY = centerY + 42 * s;
        for (let d = 1; d <= 3; d++) {
          const lit = d <= count;
          const dx = centerX + (d - 2) * dotGap;
          ctx.beginPath();
          ctx.arc(dx, dotY, lit ? dotR * 1.15 : dotR * 0.9, 0, Math.PI * 2);
          ctx.fillStyle = lit ? this.accent : "rgba(255, 255, 255, 0.22)";
          ctx.fill();
        }
      } else {
        ctx.font = `700 ${Math.round(52 * s)}px ${FONT_FAMILY}`;
        ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
        ctx.fillText("♪", centerX, centerY - 12 * s);
      }

      // Upcoming first line dimmed below
      const upcoming = first.text || "♪";
      const { fontSize: nextSize, rows: nextRows } = fitWrappedText(
        ctx,
        upcoming,
        maxWidth,
        2,
        Math.round(28 * s),
        Math.round(20 * s),
        600,
      );
      ctx.font = `600 ${nextSize}px ${FONT_FAMILY}`;
      ctx.fillStyle = "rgba(242, 243, 245, 0.45)";
      const nextLH = Math.round(nextSize * 1.32);
      let ny = centerY + 96 * s;
      for (const row of nextRows) {
        ctx.fillText(row, centerX, ny);
        ny += nextLH;
      }

      ctx.restore();
      return;
    }

    const curLine = this.lines[idx];
    const nextLine = idx + 1 < this.lines.length ? this.lines[idx + 1] : null;
    const prevLine = idx > 0 ? this.lines[idx - 1] : null;

    // Current line: large & bold, wrapped to max 3 rows, adaptive font size
    const curText = curLine.text || "♪";
    const { fontSize: curSize, rows: curRows } = fitWrappedText(
      ctx,
      curText,
      maxWidth,
      3,
      Math.round(54 * s),
      Math.round(30 * s),
      700,
    );
    const curLH = Math.round(curSize * 1.24);
    const curBlockH = curRows.length * curLH;
    const curStartY = centerY - curBlockH / 2 + curLH / 2;

    // Previous line (faint context above)
    if (prevLine) {
      const prevSize = Math.round(22 * s);
      ctx.font = `600 ${prevSize}px ${FONT_FAMILY}`;
      ctx.fillStyle = "rgba(242, 243, 245, 0.28)";
      const prevText = truncateLine(ctx, prevLine.text || "♪", maxWidth);
      ctx.fillText(prevText, centerX, curStartY - curLH * 0.5 - 38 * s);
    }

    // Current line, whole (no left-to-right sweep: it is distracting on wrapped lines)
    ctx.font = `700 ${curSize}px ${FONT_FAMILY}`;
    for (let i = 0; i < curRows.length; i++) {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = hexOrRgbWithAlpha(this.accent, 0.55);
      ctx.shadowBlur = 18 * s;
      ctx.fillText(curRows[i], centerX, curStartY + i * curLH);
      ctx.restore();
    }

    // Next line (smaller and dimmed below)
    if (nextLine) {
      const nextText = nextLine.text || "♪";
      const { fontSize: nextSize, rows: nextRows } = fitWrappedText(
        ctx,
        nextText,
        maxWidth,
        2,
        Math.round(28 * s),
        Math.round(20 * s),
        600,
      );
      ctx.font = `600 ${nextSize}px ${FONT_FAMILY}`;
      ctx.fillStyle = "rgba(242, 243, 245, 0.52)";
      const nextLH = Math.round(nextSize * 1.32);
      let ny = curStartY + (curRows.length - 0.5) * curLH + 42 * s;
      for (const row of nextRows) {
        ctx.fillText(row, centerX, ny);
        ny += nextLH;
      }
    }

    ctx.restore();
  }

  private drawBottomBar(timeSec: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const padX = 72 * s;
    const barY = this.height - 54 * s;
    const barH = Math.max(4, Math.round(5 * s));
    const barW = this.width - padX * 2;
    const frac = Math.max(0, Math.min(1, timeSec / this.duration));

    ctx.save();
    // Track
    drawRoundedRect(ctx, padX, barY, barW, barH, barH / 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fill();

    // Filled progress
    const fillW = Math.max(barH, barW * frac);
    if (frac > 0) {
      drawRoundedRect(ctx, padX, barY, Math.min(barW, fillW), barH, barH / 2);
      ctx.fillStyle = this.accent;
      ctx.fill();
    }

    // Time label: m:ss / m:ss
    ctx.font = `500 ${Math.round(16 * s)}px ${FONT_FAMILY}`;
    ctx.fillStyle = "rgba(242, 243, 245, 0.7)";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${fmtTime(timeSec)} / ${fmtTime(this.duration)}`, this.width - padX, barY - 10 * s);
    ctx.restore();
  }
}
