import { checkPublicMediaUrl } from "./policy";
import { mediaLimits } from "./limits";
import { scaledSize } from "./prepare-image";

const videoTypes = ["video/mp4", "video/webm"];
const sampleRate = 16_000;
export const videoLimits = { bytes: 24 * 1024 * 1024, seconds: 120, frames: 3 };

export function assertRecipeVideo(video: Blob): void {
  if (!videoTypes.includes(video.type.split(";")[0]) || !video.size) {
    throw new TypeError("Expected an MP4 or WebM video.");
  }
  if (video.size > videoLimits.bytes) throw new RangeError("The video exceeds the input limit.");
}

/** Reads only a listed video that the source explicitly makes available to this origin. */
export async function downloadRecipeVideo(url: string, signal: AbortSignal, send: typeof fetch = fetch): Promise<Blob> {
  const checked = checkPublicMediaUrl(url);
  if (!checked.ok || checked.url.port) throw new TypeError("Unsupported video source.");
  const response = await send(checked.url, {
    mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok || !response.body) throw new TypeError("The video is unavailable.");
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!videoTypes.includes(type) || Number(response.headers.get("Content-Length")) > videoLimits.bytes) {
    await response.body.cancel();
    throw new TypeError("The source did not provide a supported short video.");
  }

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > videoLimits.bytes) {
        await reader.cancel();
        throw new RangeError("The video exceeds the input limit.");
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const video = new Blob(chunks, { type });
  assertRecipeVideo(video);
  return video;
}

function waitForMedia(video: HTMLVideoElement, event: "loadedmetadata" | "seeked", signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      cleanup();
      reject(signal.reason ?? new Error("Video processing stopped."));
    };
    const failed = () => {
      cleanup();
      reject(new TypeError("Browser could not decode the video."));
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      signal.removeEventListener("abort", stop);
      video.removeEventListener("error", failed);
      video.removeEventListener(event, done);
    };
    if (signal.aborted) {
      stop();
      return;
    }
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", stop, { once: true });
  });
}

async function withShortVideo<T>(
  blob: Blob, cancel: AbortSignal, use: (video: HTMLVideoElement, signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  assertRecipeVideo(blob);
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(20_000)]);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(blob);
  try {
    const loaded = waitForMedia(video, "loadedmetadata", signal);
    video.src = url;
    await loaded;
    if (!(video.duration > 0 && video.duration <= videoLimits.seconds)
      || video.videoWidth * video.videoHeight > 16_000_000 || !video.videoWidth || !video.videoHeight) {
      throw new RangeError("Unsupported video duration or frame size.");
    }
    return await use(video, signal);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Samples visible frames in chronological order without playing, uploading or retaining the video. */
export async function readRecipeVideoFrames(blob: Blob, cancel: AbortSignal): Promise<Blob[]> {
  return withShortVideo(blob, cancel, async (video, signal) => {
    const canvas = document.createElement("canvas");
    const size = scaledSize(video.videoWidth, video.videoHeight, mediaLimits.maxEdgePixels);
    canvas.width = size.width;
    canvas.height = size.height;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new TypeError("Canvas is unavailable.");

    const frames: Blob[] = [];
    for (let index = 0; index < videoLimits.frames; index++) {
      signal.throwIfAborted();
      const time = video.duration * (index + 0.5) / videoLimits.frames;
      const seek = waitForMedia(video, "seeked", signal);
      video.currentTime = time;
      await seek;
      drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (frame) frames.push(frame);
    }
    return frames;
  });
}

/** Extracts mono 16 kHz PCM in memory. Only this audio can be sent to transcription. */
export async function extractRecipeVideoAudio(video: Blob, signal: AbortSignal): Promise<Blob> {
  await withShortVideo(video, signal, () => undefined);
  const bytes = await video.arrayBuffer();
  signal.throwIfAborted();
  const decoded = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes);
  signal.throwIfAborted();
  if (!(decoded.duration > 0 && decoded.duration <= videoLimits.seconds)) {
    throw new RangeError("Unsupported length for recipe audio.");
  }
  const mixer = new OfflineAudioContext(1, decoded.length, sampleRate);
  const source = mixer.createBufferSource();
  source.buffer = decoded;
  source.connect(mixer.destination);
  source.start();
  const audio = (await mixer.startRendering()).getChannelData(0);
  signal.throwIfAborted();

  const wav = new DataView(new ArrayBuffer(44 + audio.length * 2));
  const header = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) wav.setUint8(offset + index, text.charCodeAt(index));
  };
  header(0, "RIFF");
  wav.setUint32(4, wav.byteLength - 8, true);
  header(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, sampleRate, true);
  wav.setUint32(28, sampleRate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  header(36, "data");
  wav.setUint32(40, audio.length * 2, true);
  for (let index = 0; index < audio.length; index++) {
    wav.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, audio[index])) * 32767), true);
  }
  return new Blob([wav.buffer], { type: "audio/wav" });
}
