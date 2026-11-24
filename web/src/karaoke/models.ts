// The vocal separation models users can pick. MDX-Net parameters come from UVR's
// mdx_model_data/model_data.json (keyed by the model's hash); Spleeter's from
// sherpa-onnx (k2-fsa), which exported it to ONNX.

export type ModelId = "spleeter" | "kara" | "kara2" | "hq3";

export type MdxParams = {
  nFft: number; // n_fft (window and FFT size)
  dimF: number; // frequency bins fed to the model
  dimT: number; // frames per chunk (2^mdx_dim_t_set)
  hop: number;
  compensate: number;
  /** What the model outputs; for "vocals" the instrumental is mix − vocals. */
  primary: "instrumental" | "vocals";
};

export type KaraokeModel =
  | ({ kind: "mdx"; id: Exclude<ModelId, "spleeter">; sizeMb: number } & MdxParams)
  /** Spleeter 2-stems (int8): two networks (vocals, accompaniment) on magnitude spectra. */
  | { kind: "spleeter"; id: "spleeter"; sizeMb: number };

export const MODELS: Record<ModelId, KaraokeModel> = {
  // Spleeter 2 stems, int8: ~7× faster than KARA on a CPU, rougher; keeps up with playback on weak computers.
  spleeter: { kind: "spleeter", id: "spleeter", sizeMb: 52 },
  // UVR_MDXNET_KARA: removes the lead vocal, keeps backing vocals.
  kara: { kind: "mdx", id: "kara", sizeMb: 30, nFft: 6144, dimF: 2048, dimT: 256, hop: 1024, compensate: 1.035, primary: "vocals" },
  // UVR_MDXNET_KARA_2: the same idea, cleaner.
  kara2: { kind: "mdx", id: "kara2", sizeMb: 53, nFft: 5120, dimF: 2048, dimT: 256, hop: 1024, compensate: 1.065, primary: "instrumental" },
  // UVR-MDX-NET-Inst_HQ_3: removes all vocals, best quality, heaviest.
  hq3: { kind: "mdx", id: "hq3", sizeMb: 67, nFft: 6144, dimF: 3072, dimT: 256, hop: 1024, compensate: 1.022, primary: "instrumental" },
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];
export const DEFAULT_MODEL: ModelId = "kara";

export const isModelId = (v: unknown): v is ModelId => typeof v === "string" && v in MODELS;

/** ONNX files of a model, served by the server (downloaded there once). */
export const modelUrls = (id: ModelId): string[] =>
  id === "spleeter" ? ["/api/karaoke/model?m=spleeter-vocals", "/api/karaoke/model?m=spleeter-accompaniment"] : [`/api/karaoke/model?m=${id}`];
