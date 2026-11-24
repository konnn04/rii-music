import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from "mediabunny";
import type { Line } from "@/components/layout/LyricsView";
import { t } from "@/i18n";
import type { Track } from "@/lib/api";
import {
  TARGET_SAMPLE_RATE,
  computeBeatEnvelope,
  makeAbortError,
  prepareAudio,
  sliceAudioBuffer,
  type AudioChoice,
} from "./audio";
import {
  KaraokeFrameRenderer,
  RESOLUTIONS,
  loadCanvasFonts,
  loadCoverBitmap,
  type Resolution,
} from "./canvas";

export const EXPORT_FPS = 30;
const AUDIO_CHUNK_SECONDS = 10;

export type RenderPhase = "prepare" | "render" | "finalize";

export type RenderProgress = {
  phase: RenderPhase;
  frame: number;
  totalFrames: number;
};

export type RenderOptions = {
  track: Track;
  resolution: Resolution;
  audioChoice: AudioChoice;
  showLyrics: boolean;
  lines: Line[];
  offsetMs: number;
  signal: AbortSignal;
  onProgress: (p: RenderProgress) => void;
};

export type RenderResult = {
  blob: Blob;
  mimeType: string;
  extension: string;
  filename: string;
};

type SelectedFormat = {
  format: OutputFormat;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
};

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw makeAbortError();
}

function sanitizeFilenamePart(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFilename(track: Track, extension: string): string {
  const title = sanitizeFilenamePart(track.title) || "Track";
  const artist = sanitizeFilenamePart(track.artist || t("common.unknownArtist")) || "Unknown";
  return `${title} - ${artist} (karaoke)${extension}`;
}

async function selectOutputFormat(width: number, height: number): Promise<SelectedFormat> {
  const videoOpts = { width, height, frameRate: EXPORT_FPS, quality: QUALITY_HIGH };
  const audioOpts = { numberOfChannels: 2, sampleRate: TARGET_SAMPLE_RATE, quality: QUALITY_HIGH };

  const [canAvc, canAac] = await Promise.all([
    canEncodeVideo("avc", videoOpts).catch(() => false),
    canEncodeAudio("aac", audioOpts).catch(() => false),
  ]);

  if (canAvc && canAac) {
    return {
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      videoCodec: "avc",
      audioCodec: "aac",
    };
  }

  const [canVp9, canOpus] = await Promise.all([
    canEncodeVideo("vp9", videoOpts).catch(() => false),
    canEncodeAudio("opus", audioOpts).catch(() => false),
  ]);

  if (canVp9 && canOpus) {
    return {
      format: new WebMOutputFormat(),
      videoCodec: "vp9",
      audioCodec: "opus",
    };
  }

  const canVp8 = canOpus ? await canEncodeVideo("vp8", videoOpts).catch(() => false) : false;
  if (canVp8 && canOpus) {
    return {
      format: new WebMOutputFormat(),
      videoCodec: "vp8",
      audioCodec: "opus",
    };
  }

  throw new Error(t("karaokeVideo.errorUnsupported"));
}

/**
 * Render and encode a karaoke video (MP4 preferred, WebM fallback) entirely in the browser.
 */
export async function renderKaraokeVideo(opts: RenderOptions): Promise<RenderResult> {
  const { track, resolution, audioChoice, showLyrics, lines, offsetMs, signal, onProgress } = opts;
  const { width, height } = RESOLUTIONS[resolution];

  checkAborted(signal);
  onProgress({ phase: "prepare", frame: 0, totalFrames: 0 });

  const selected = await selectOutputFormat(width, height);
  checkAborted(signal);

  let cover: ImageBitmap | null = null;
  let output: Output<OutputFormat, BufferTarget> | null = null;
  let finalized = false;

  try {
    const [, loadedCover, audioBuffer] = await Promise.all([
      loadCanvasFonts(),
      loadCoverBitmap(track.id, track.hasCover, signal),
      prepareAudio(track.id, audioChoice, signal).catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        throw new Error(t("karaokeVideo.errorNoAudio"));
      }),
    ]);
    cover = loadedCover;
    checkAborted(signal);

    const duration = audioBuffer.duration;
    const totalFrames = Math.max(1, Math.ceil(duration * EXPORT_FPS));
    const beatEnvelope = computeBeatEnvelope(audioBuffer, EXPORT_FPS);

    const renderer = new KaraokeFrameRenderer({
      width,
      height,
      track,
      cover,
      duration,
      beatEnvelope,
      showLyrics,
      lines,
      offsetMs,
    });

    const target = new BufferTarget();
    output = new Output({ format: selected.format, target });

    const videoSource = new CanvasSource(renderer.canvas, {
      codec: selected.videoCodec,
      quality: QUALITY_HIGH,
    });
    const audioSource = new AudioBufferSource({
      codec: selected.audioCodec,
      quality: QUALITY_HIGH,
    });

    output.addVideoTrack(videoSource, { frameRate: EXPORT_FPS });
    output.addAudioTrack(audioSource);
    output.setMetadataTags({
      title: track.title,
      artist: track.artist || undefined,
      album: track.album || undefined,
    });

    await output.start();
    checkAborted(signal);

    onProgress({ phase: "render", frame: 0, totalFrames });

    const chunkSamples = audioBuffer.sampleRate * AUDIO_CHUNK_SECONDS;
    let nextAudioSample = 0;

    for (let frame = 0; frame < totalFrames; frame++) {
      checkAborted(signal);
      const timeSec = frame / EXPORT_FPS;

      // Interleave audio in ~10 s pieces so audio and video tracks advance together
      while (nextAudioSample < audioBuffer.length && nextAudioSample / audioBuffer.sampleRate <= timeSec) {
        const end = Math.min(audioBuffer.length, nextAudioSample + chunkSamples);
        await audioSource.add(sliceAudioBuffer(audioBuffer, nextAudioSample, end));
        nextAudioSample = end;
        checkAborted(signal);
      }

      renderer.drawFrame(timeSec, frame);
      await videoSource.add(timeSec, 1 / EXPORT_FPS);

      if (frame % 15 === 0 || frame === totalFrames - 1) {
        onProgress({ phase: "render", frame: frame + 1, totalFrames });
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    // Flush any remaining audio tail
    while (nextAudioSample < audioBuffer.length) {
      checkAborted(signal);
      const end = Math.min(audioBuffer.length, nextAudioSample + chunkSamples);
      await audioSource.add(sliceAudioBuffer(audioBuffer, nextAudioSample, end));
      nextAudioSample = end;
    }

    audioSource.close();
    videoSource.close();

    checkAborted(signal);
    onProgress({ phase: "finalize", frame: totalFrames, totalFrames });
    await output.finalize();
    finalized = true;

    const buffer = target.buffer;
    if (!buffer) {
      throw new Error(t("karaokeVideo.error"));
    }

    const mimeType = selected.format.mimeType;
    const extension = selected.format.fileExtension;
    const blob = new Blob([buffer], { type: mimeType });

    return {
      blob,
      mimeType,
      extension,
      filename: buildFilename(track, extension),
    };
  } catch (err) {
    if (output && !finalized && output.state !== "canceled") {
      await output.cancel().catch(() => {});
    }
    throw err;
  } finally {
    cover?.close();
  }
}
