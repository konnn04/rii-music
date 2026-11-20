// Dominant, desaturated accent colour from a cover image, tuned to stay readable
// (≥ 4.5:1) as text/icon colour on the dark Now Playing scrim.

const cache = new Map<string, string | null>();

export async function extractAccent(src: string): Promise<string | null> {
  if (cache.has(src)) return cache.get(src)!;
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  try {
    await img.decode();
  } catch {
    cache.set(src, null);
    return null;
  }
  const n = 24;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;

  // 24-bucket hue histogram weighted by saturation × mid-lightness.
  const bins = new Array(24).fill(0).map(() => ({ w: 0, h: 0, s: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    const w = s * (1 - Math.abs(l - 0.5) * 2) + 0.001;
    const b = bins[Math.floor(h * 24) % 24];
    b.w += w;
    b.h += h * w;
    b.s += s * w;
  }
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
  let color: string;
  if (best.w < 2) {
    color = "hsl(232 60% 74%)"; // greyscale cover: default accent family
  } else {
    const h = (best.h / best.w) * 360;
    const s = Math.min(62, Math.max(32, (best.s / best.w) * 100 * 0.75));
    color = `hsl(${Math.round(h)} ${Math.round(s)}% 72%)`;
  }
  cache.set(src, color);
  return color;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
