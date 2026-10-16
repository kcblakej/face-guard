import type { FrameInput } from './detector';

export async function openCamera(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      facingMode: deviceId ? undefined : 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  });
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

/** Hands out the most recent camera frame on demand. */
export interface FrameSource {
  readonly kind: string;
  grab(): Promise<FrameInput | null>;
  release(frame: FrameInput): void;
  stop(): void;
}

/**
 * Reads frames straight off the camera track. Unlike a <video> element this keeps
 * delivering frames when the window is hidden or minimized to the tray.
 */
class TrackProcessorSource implements FrameSource {
  readonly kind = 'track-processor';
  private latest: VideoFrame | null = null;
  private running = true;
  private reader: ReadableStreamDefaultReader<VideoFrame>;

  constructor(track: MediaStreamVideoTrack) {
    const Processor = (window as unknown as { MediaStreamTrackProcessor: MediaStreamTrackProcessorCtor })
      .MediaStreamTrackProcessor;
    this.reader = new Processor({ track }).readable.getReader();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done || !value) break;
        this.latest?.close();
        this.latest = value;
      }
    } catch {
      /* track ended */
    }
  }

  async grab(): Promise<FrameInput | null> {
    const frame = this.latest;
    if (!frame) return null;
    this.latest = null;
    try {
      return await createImageBitmap(frame);
    } finally {
      frame.close();
    }
  }

  release(frame: FrameInput): void {
    if (frame instanceof ImageBitmap) frame.close();
  }

  stop(): void {
    this.running = false;
    this.latest?.close();
    this.latest = null;
    void this.reader.cancel().catch(() => undefined);
  }
}

/** Fallback (Safari / iOS): read from the playing <video> element. */
class VideoElementSource implements FrameSource {
  readonly kind = 'video-element';
  private lastTime = -1;

  constructor(private readonly video: HTMLVideoElement) {}

  async grab(): Promise<FrameInput | null> {
    if (this.video.readyState < 2 || this.video.videoWidth === 0) return null;
    // Skip if the video hasn't advanced (no new frame since last grab).
    if (this.video.currentTime === this.lastTime) return null;
    this.lastTime = this.video.currentTime;
    return this.video;
  }

  release(): void {}
  stop(): void {}
}

interface MediaStreamTrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
}

type MediaStreamVideoTrack = MediaStreamTrack;

export function createFrameSource(stream: MediaStream, video: HTMLVideoElement): FrameSource {
  const track = stream.getVideoTracks()[0];
  if (track && 'MediaStreamTrackProcessor' in window) {
    try {
      return new TrackProcessorSource(track);
    } catch (err) {
      console.warn('[face-guard] MediaStreamTrackProcessor unavailable, using <video>', err);
    }
  }
  return new VideoElementSource(video);
}

/**
 * A steady tick that isn't throttled when the page is in the background.
 * Timers inside a dedicated worker keep running; posting back to the page wakes it up.
 */
export class Ticker {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onTick: () => void) {}

  start(intervalMs: number): void {
    this.stop();
    try {
      const src = `let id=null;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data);};`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      this.worker.onmessage = () => this.onTick();
      this.worker.postMessage(intervalMs);
    } catch {
      this.worker = null;
      this.timer = setInterval(this.onTick, intervalMs);
    }
  }

  stop(): void {
    if (this.worker) {
      this.worker.postMessage(0);
      this.worker.terminate();
      this.worker = null;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
