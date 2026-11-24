// The vocal separation models users can pick (UVR MDX-Net, ONNX). Parameters
// come from UVR's mdx_model_data/model_data.json (keyed by the model's hash).

export type ModelId = "kara" | "kara2" | "hq3";

export type MdxParams = {
  nFft: number; // n_fft (window and FFT size)
  dimF: number; // frequency bins fed to the model
  dimT: number; // frames per chunk (2^mdx_dim_t_set)
  hop: number;
  compensate: number;
  /** What the model outputs; for "vocals" the instrumental is mix − vocals. */
  primary: "instrumental" | "vocals";
};

export type KaraokeModel = MdxParams & { id: ModelId; sizeMb: number };

export const MODELS: Record<ModelId, KaraokeModel> = {
  // UVR_MDXNET_KARA: removes the lead vocal, keeps backing vocals. Lightest.
  kara: { id: "kara", sizeMb: 30, nFft: 6144, dimF: 2048, dimT: 256, hop: 1024, compensate: 1.035, primary: "vocals" },
  // UVR_MDXNET_KARA_2: the same idea, cleaner.
  kara2: { id: "kara2", sizeMb: 53, nFft: 5120, dimF: 2048, dimT: 256, hop: 1024, compensate: 1.065, primary: "instrumental" },
  // UVR-MDX-NET-Inst_HQ_3: removes all vocals, best quality, heaviest.
  hq3: { id: "hq3", sizeMb: 67, nFft: 6144, dimF: 3072, dimT: 256, hop: 1024, compensate: 1.022, primary: "instrumental" },
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];
export const DEFAULT_MODEL: ModelId = "kara";

export const isModelId = (v: unknown): v is ModelId => typeof v === "string" && v in MODELS;

export const modelUrl = (id: ModelId) => `/api/karaoke/model?m=${id}`;
