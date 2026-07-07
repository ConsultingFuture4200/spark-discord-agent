import OBSWebSocket from "obs-websocket-js";
import type { Logger } from "./logger.js";

/**
 * Drives a participant-side OBS instance to record the call's composited video
 * (SPEC M7 / Path A). Every method is **best-effort**: an OBS connect/request
 * failure is logged and degrades the call to audio-only — it must never throw
 * out of the {@link CallRecorder} lifecycle or block manifest write / enqueue.
 */
export interface VideoRecorder {
  /** OBS `StartRecord`; `startedAtMs` is the clock read at the StartRecord ack. */
  startRecording(): Promise<{ startedAtMs: number }>;
  /** OBS `StopRecord`; `outputPath` is the file OBS wrote, or null on failure. */
  stopRecording(): Promise<{ outputPath: string | null }>;
  /** Tear down the OBS connection. Best-effort. */
  dispose(): Promise<void>;
}

/**
 * Minimal seam over `obs-websocket-js` so the recorder is unit-testable without
 * a live OBS. The default implementation ({@link createObsWsClient}) wraps the
 * real v5 client; tests inject a fake.
 */
export interface ObsWsClient {
  connect(url: string, password: string | undefined): Promise<void>;
  startRecord(): Promise<void>;
  stopRecord(): Promise<{ outputPath: string | null }>;
  disconnect(): Promise<void>;
}

/** Wrap the real `obs-websocket-js` v5 client behind {@link ObsWsClient}. */
function createObsWsClient(): ObsWsClient {
  const obs = new OBSWebSocket();
  return {
    async connect(url, password): Promise<void> {
      await obs.connect(url, password);
    },
    async startRecord(): Promise<void> {
      await obs.call("StartRecord");
    },
    async stopRecord(): Promise<{ outputPath: string | null }> {
      const res = await obs.call("StopRecord");
      return { outputPath: res.outputPath ?? null };
    },
    async disconnect(): Promise<void> {
      await obs.disconnect();
    },
  };
}

export interface ObsVideoRecorderDeps {
  websocketUrl: string;
  websocketPassword: string | undefined;
  logger: Logger;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable transport for tests; defaults to the real OBS WebSocket. */
  client?: ObsWsClient;
}

/**
 * {@link VideoRecorder} backed by OBS WebSocket v5. Connects lazily on the first
 * {@link startRecording} and never throws: any failure is logged and the call
 * degrades to audio-only (a `null` output path leaves `manifest.video` unset).
 */
export class ObsVideoRecorder implements VideoRecorder {
  private readonly url: string;
  private readonly password: string | undefined;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly client: ObsWsClient;

  private connected = false;
  private recording = false;

  constructor(deps: ObsVideoRecorderDeps) {
    this.url = deps.websocketUrl;
    this.password = deps.websocketPassword;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
    this.client = deps.client ?? createObsWsClient();
  }

  async startRecording(): Promise<{ startedAtMs: number }> {
    if (!(await this.ensureConnected())) return { startedAtMs: this.now() };
    try {
      await this.client.startRecord();
      this.recording = true;
      // Capture the clock at the StartRecord ack — the offset math aligns the
      // transcript to this instant.
      return { startedAtMs: this.now() };
    } catch (err) {
      this.log.warn("OBS StartRecord failed; recording audio-only", err);
      return { startedAtMs: this.now() };
    }
  }

  async stopRecording(): Promise<{ outputPath: string | null }> {
    if (!this.connected || !this.recording) return { outputPath: null };
    try {
      const { outputPath } = await this.client.stopRecord();
      this.recording = false;
      return { outputPath };
    } catch (err) {
      this.log.warn("OBS StopRecord failed; no video for this call", err);
      return { outputPath: null };
    }
  }

  async dispose(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.disconnect();
    } catch (err) {
      this.log.warn("OBS disconnect failed", err);
    }
    this.connected = false;
  }

  /** Lazily connect. Returns false (logged) if OBS is unreachable. */
  private async ensureConnected(): Promise<boolean> {
    if (this.connected) return true;
    try {
      await this.client.connect(this.url, this.password);
      this.connected = true;
      return true;
    } catch (err) {
      this.log.warn(`OBS connect to ${this.url} failed; recording audio-only`, err);
      return false;
    }
  }
}

/**
 * No-op recorder used when the OBS feature is off (`config.obs` undefined). Every
 * call is a no-op returning a null output path, so the lifecycle code needs no
 * branching and behavior is byte-for-byte identical to pre-M7 (audio-only).
 */
export class NoopVideoRecorder implements VideoRecorder {
  async startRecording(): Promise<{ startedAtMs: number }> {
    return { startedAtMs: 0 };
  }
  async stopRecording(): Promise<{ outputPath: string | null }> {
    return { outputPath: null };
  }
  async dispose(): Promise<void> {
    // nothing to tear down
  }
}
