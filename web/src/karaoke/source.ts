const instrumentals = new Map<string, string>();

export function registerInstrumental(trackId: string, url: string): void {
  const prev = instrumentals.get(trackId);
  if (prev && prev !== url && prev.startsWith("blob:")) {
    URL.revokeObjectURL(prev);
  }
  instrumentals.set(trackId, url);
}

export function instrumentalUrl(trackId: string): string | null {
  return instrumentals.get(trackId) ?? null;
}

export function unregisterInstrumental(trackId: string): void {
  const prev = instrumentals.get(trackId);
  if (!prev) return;
  instrumentals.delete(trackId);
  if (prev.startsWith("blob:")) {
    URL.revokeObjectURL(prev);
  }
}
