import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
  type VoiceReceiver,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import prism from "prism-media";
import {
  AUDIO_DIRNAME,
  VIDEO_FILENAME,
  createCallManifest,
  ensureCallDir,
  speakerTrackPath,
  videoPath,
  writeManifest,
  writeStatus,
  VideoDescriptorSchema,
  type CallManifest,
  type SpeakerTrack,
  type VideoDescriptor,
} from "@discord-agent/shared";
import type { Logger } from "../logger.js";
import { NoopVideoRecorder, type VideoRecorder } from "../obs.js";
import { moveRecorder } from "./recorderMove.js";
import {
  PCM_CHANNELS,
  PCM_SAMPLE_RATE,
  SpeakerRecorder,
} from "./speakerRecorder.js";

/** Opus frame size at 48 kHz: 20 ms = 960 samples. */
const OPUS_FRAME_SIZE = 960;
/** Silence (ms) that ends a per-user receive stream; the next burst reopens it. */
const RECEIVE_SILENCE_END_MS = 1_000;
/** How long to wait for the voice connection to become Ready before failing. */
const READY_TIMEOUT_MS = 20_000;
/** Default bound on the OBS-recording copy so a hung mount never blocks stop(). */
const VIDEO_COPY_TIMEOUT_MS = 60_000;

export interface CallRecorderDeps {
  channel: VoiceBasedChannel;
  /** Base storage dir (`config.storage.dir`). */
  storageDir: string;
  logger: Logger;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Video recorder (OBS). Defaults to {@link NoopVideoRecorder} so behavior is
   * byte-for-byte identical to audio-only when the OBS feature is off.
   */
  videoRecorder?: VideoRecorder;
  /**
   * Folder OBS writes recordings to, as reachable by the capture service. When
   * set, the finished recording is copied from here into the call dir.
   */
  obsOutputDir?: string;
  /** Whether the recording announcement should also mention video (consent). */
  videoEnabled?: boolean;
  /**
   * Recorder account (OBS capture user) to pull into the call channel before OBS
   * StartRecord, so the first frames capture the call and not the lobby. Moving
   * an already-connected member is best-effort; undefined disables the move.
   */
  recorderUserId?: string;
  /** Bound on the OBS-recording copy into the call dir; defaults to 60s. */
  videoCopyTimeoutMs?: number;
}

/**
 * Manages the recording of a single active voice call: joins over DAVE, opens
 * one {@link SpeakerRecorder} per speaker on demand, and on stop finalizes the
 * tracks, writes the {@link CallManifest}, and flips `status.json` to
 * `ready-to-process` so the processing service picks it up.
 */
export class CallRecorder {
  readonly callId: string;
  readonly channelId: string;

  private readonly channel: VoiceBasedChannel;
  private readonly storageDir: string;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly videoRecorder: VideoRecorder;
  private readonly obsOutputDir: string | undefined;
  private readonly videoEnabled: boolean;
  private readonly recorderUserId: string | undefined;
  private readonly videoCopyTimeoutMs: number;
  /** Clock read at the OBS StartRecord ack; null until (and unless) it starts. */
  private videoStartedAtMs: number | null = null;

  private connection: VoiceConnection | null = null;
  private readonly recorders = new Map<string, SpeakerRecorder>();
  /** Users with an in-flight receive subscription (dedupes speaking bursts). */
  private readonly activeUsers = new Set<string>();
  private stopped = false;

  constructor(deps: CallRecorderDeps) {
    this.now = deps.now ?? Date.now;
    this.channel = deps.channel;
    this.channelId = deps.channel.id;
    this.storageDir = deps.storageDir;
    this.log = deps.logger;
    this.videoRecorder = deps.videoRecorder ?? new NoopVideoRecorder();
    this.obsOutputDir = deps.obsOutputDir;
    this.videoEnabled = deps.videoEnabled ?? false;
    this.recorderUserId = deps.recorderUserId;
    this.videoCopyTimeoutMs = deps.videoCopyTimeoutMs ?? VIDEO_COPY_TIMEOUT_MS;
    this.startedAtMs = this.now();
    this.callId = makeCallId(this.startedAtMs, this.channelId);
  }

  /** Join the channel, wire the receiver, and announce that recording started. */
  async start(): Promise<void> {
    await ensureCallDir(this.storageDir, this.callId);
    await writeStatus(
      this.storageDir,
      this.callId,
      "recording",
      new Date(this.startedAtMs).toISOString(),
    );

    const connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must be undeafened to receive audio
      selfMute: true, // no in-call TTS in v1 (PRD non-goal)
    });
    this.connection = connection;
    this.wireConnection(connection);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (err) {
      connection.destroy();
      this.connection = null;
      throw new Error(
        `voice connection to ${this.channelId} never became ready: ${String(err)}`,
      );
    }

    this.wireReceiver(connection.receiver);
    // Pull the recorder account into the call BEFORE OBS StartRecord, otherwise
    // OBS captures the lobby for the first frames. Best-effort and gated: only an
    // already-connected recorder member is movable.
    await this.moveRecorderIntoCall();
    await this.announce();
    // Best-effort video: OBS problems must never crash the recording. The
    // VideoRecorder is internally non-throwing, but guard defensively so a
    // misbehaving implementation degrades to audio-only rather than aborting.
    try {
      const { startedAtMs } = await this.videoRecorder.startRecording();
      this.videoStartedAtMs = startedAtMs;
    } catch (err) {
      this.log.warn(`video recording failed to start for ${this.callId}`, err);
    }
    this.log.info(`recording started: call ${this.callId} in ${this.channelId}`);
  }

  private wireConnection(connection: VoiceConnection): void {
    // Resilience (NFR-3): a Disconnected connection may be a transient move or
    // websocket blip. Give it a moment to reconnect and become Ready again; if it
    // recovers, re-subscribe the receiver so audio actually resumes (the old
    // per-user opus subscriptions died with the disconnect). If it doesn't
    // recover, stop cleanly so the partial call is still enqueued and summarized.
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void (async () => {
        if (this.stopped) return;
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
          if (this.stopped) return;
          this.log.warn(`voice reconnected for ${this.channelId}; re-subscribing`);
          // The old per-user subscriptions are dead; let speakers re-subscribe on
          // their next burst and re-wire the speaking listener onto the receiver.
          this.activeUsers.clear();
          this.wireReceiver(connection.receiver);
        } catch {
          this.log.warn(
            `voice disconnected and did not recover for ${this.channelId}; stopping`,
          );
          await this.stop();
        }
      })();
    });
    connection.on("error", (err) =>
      this.log.error(`voice connection error in ${this.channelId}`, err),
    );
  }

  /** Announce in the channel's own text chat that recording has started (FR-10). */
  private async announce(): Promise<void> {
    try {
      if (this.channel.isTextBased()) {
        // Consent (NFR-6 / D-7): when OBS is active the notice must state that
        // video is also being recorded.
        await this.channel.send(
          this.videoEnabled
            ? "Recording started. This call is being recorded (audio and video) and transcribed locally for a post-call summary."
            : "Recording started. This call is being recorded and transcribed locally for a post-call summary.",
        );
      }
    } catch (err) {
      this.log.warn(`failed to announce recording in ${this.channelId}`, err);
    }
  }

  /**
   * Pull the configured recorder account into the call channel (best-effort).
   * Gated to an already-connected member: a bot may not originate a user's voice
   * connection, but moving a connected member is a normal Move Members action.
   */
  private async moveRecorderIntoCall(): Promise<void> {
    if (!this.recorderUserId) return;
    await moveRecorder({
      recorderUserId: this.recorderUserId,
      member: this.channel.guild.members.cache.get(this.recorderUserId) ?? null,
      targetChannelId: this.channelId,
      logger: this.log,
      context: "into call",
    });
  }

  private wireReceiver(receiver: VoiceReceiver): void {
    // Idempotent: drop any prior listener so a reconnect re-wire never stacks
    // duplicate 'start' handlers (which would double-subscribe every speaker).
    receiver.speaking.removeAllListeners("start");
    receiver.speaking.on("start", (userId: string) => {
      this.onSpeakingStart(receiver, userId);
    });
  }

  /** Begin (or resume) capturing a speaker when they start talking. */
  private onSpeakingStart(receiver: VoiceReceiver, userId: string): void {
    if (this.stopped) return;
    // A single burst can emit multiple 'start' events; only subscribe once.
    if (this.activeUsers.has(userId)) return;
    this.activeUsers.add(userId);

    const recorder = this.getOrCreateRecorder(userId);
    recorder.beginUtterance();

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: RECEIVE_SILENCE_END_MS,
      },
    });
    const decoder = new prism.opus.Decoder({
      rate: PCM_SAMPLE_RATE,
      channels: PCM_CHANNELS,
      frameSize: OPUS_FRAME_SIZE,
    });

    decoder.on("data", (chunk: Buffer) => recorder.writePcm(chunk));

    const cleanup = (): void => {
      this.activeUsers.delete(userId);
    };
    // A stream "error" is its own terminal event: it may fire without a
    // following "close"/"end", so the cleanup that removes the user from
    // `activeUsers` must run here too. Without it the dedupe guard would drop
    // every future speaking event for this user and capture would silently stop
    // for that speaker. Destroy both streams so neither leaks.
    const cleanupAfterError = (): void => {
      cleanup();
      opusStream.destroy();
      decoder.destroy();
    };
    opusStream.on("error", (err) => {
      this.log.warn(`receive stream error for ${userId}`, err);
      cleanupAfterError();
    });
    decoder.on("error", (err) => {
      this.log.warn(`opus decode error for ${userId}`, err);
      cleanupAfterError();
    });
    decoder.once("end", cleanup);
    decoder.once("close", cleanup);

    opusStream.pipe(decoder);
  }

  private getOrCreateRecorder(userId: string): SpeakerRecorder {
    const displayName = this.resolveDisplayName(userId);
    const existing = this.recorders.get(userId);
    if (existing) {
      existing.updateDisplayName(displayName);
      return existing;
    }
    const recorder = new SpeakerRecorder({
      userId,
      displayName,
      filePath: speakerTrackPath(this.storageDir, this.callId, userId, "wav"),
      manifestPath: path.posix.join(AUDIO_DIRNAME, `${userId}.wav`),
      callStartedAtMs: this.startedAtMs,
      now: this.now,
      onError: (err) =>
        this.log.error(`track sink error for ${displayName} (${userId})`, err),
    });
    this.recorders.set(userId, recorder);
    this.log.debug(`new speaker track: ${displayName} (${userId})`);
    return recorder;
  }

  /** Real display name from voice-state (FR-16), falling back to the user ID. */
  private resolveDisplayName(userId: string): string {
    return (
      this.channel.members.get(userId)?.displayName ??
      this.channel.guild.members.cache.get(userId)?.displayName ??
      userId
    );
  }

  /**
   * Finalize all tracks, write the manifest, and enqueue the call for
   * processing. Idempotent: a second call is a no-op.
   */
  async stop(): Promise<CallManifest | null> {
    if (this.stopped) return null;
    this.stopped = true;

    const tracks: SpeakerTrack[] = [];
    for (const recorder of this.recorders.values()) {
      try {
        const track = await recorder.finalize();
        // Exclude tracks with no audio or whose sink errored: an incomplete WAV
        // would fail or garble transcription. A failed track never blocks the
        // rest of the call from being summarized.
        if (recorder.hasAudio && !recorder.failed) tracks.push(track);
        else if (recorder.failed)
          this.log.warn(`excluding failed track for ${recorder.userId}`);
      } catch (err) {
        this.log.error(`failed finalizing track for ${recorder.userId}`, err);
      }
    }

    const startedAtIso = new Date(this.startedAtMs).toISOString();
    const endedAtIso = new Date(this.now()).toISOString();
    const guildId = this.channel.guild.id;

    // Enqueue AUDIO FIRST. The video copy below reads from OBS_OUTPUT_DIR (a
    // possibly slow/hung mount); doing it before this write would let a hung
    // mount block enqueue + graceful shutdown, and a crash mid-copy would strand
    // a fully-captured audio call as `failed`. Writing the audio-only manifest
    // now makes the call durably enqueued and impossible to lose — a video
    // failure NEVER blocks manifest write / enqueue / delivery.
    let manifest = createCallManifest({
      callId: this.callId,
      guildId,
      channelId: this.channelId,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      tracks,
    });

    let enqueued = false;
    try {
      await writeManifest(this.storageDir, manifest);
      await writeStatus(this.storageDir, this.callId, "ready-to-process", endedAtIso);
      enqueued = true;
      this.log.info(
        `call ${this.callId} stopped: ${tracks.length} speaker track(s), ready to process`,
      );
    } catch (err) {
      this.log.error(`failed enqueuing call ${this.callId}`, err);
      await writeStatus(
        this.storageDir,
        this.callId,
        "failed",
        new Date(this.now()).toISOString(),
        err instanceof Error ? err.message : String(err),
      ).catch(() => undefined);
    }

    // Best-effort video, attached SECOND via a bounded copy + a second manifest
    // write. Any failure (timeout, copy error, malformed descriptor, or a failed
    // second write) leaves the already-enqueued audio-only manifest intact.
    const video = await this.finalizeVideo();
    if (enqueued && video) {
      try {
        const withVideo = createCallManifest({
          callId: this.callId,
          guildId,
          channelId: this.channelId,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          tracks,
          video,
        });
        await writeManifest(this.storageDir, withVideo);
        manifest = withVideo;
        this.log.info(`attached video to call ${this.callId}`);
      } catch (err) {
        this.log.warn(
          `failed attaching video to manifest for ${this.callId}; staying audio-only`,
          err,
        );
      }
    }

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    return manifest;
  }

  /**
   * Stop OBS and, if it produced a file, copy it into the call dir and build the
   * {@link VideoDescriptor}. Best-effort throughout: any failure returns
   * undefined so the call is delivered audio-only.
   */
  private async finalizeVideo(): Promise<VideoDescriptor | undefined> {
    let outputPath: string | null = null;
    try {
      ({ outputPath } = await this.videoRecorder.stopRecording());
    } catch (err) {
      this.log.warn(`video stopRecording failed for ${this.callId}`, err);
    } finally {
      await this.videoRecorder
        .dispose()
        .catch((err) => this.log.warn(`video recorder dispose failed for ${this.callId}`, err));
    }

    const videoStartedAtMs = this.videoStartedAtMs;
    if (!outputPath || videoStartedAtMs === null) return undefined;
    return this.buildVideoDescriptor(outputPath, videoStartedAtMs);
  }

  /**
   * Copy the OBS recording into the call dir as `video.mp4` (bounded) and build a
   * validated {@link VideoDescriptor}. `startOffsetMs` is the SIGNED difference
   * between the video's and the call's start (negative = OBS started first).
   * Fully defensive: a copy timeout/error OR a malformed descriptor returns
   * `undefined`, degrading the call to audio-only rather than throwing out of
   * stop().
   */
  private async buildVideoDescriptor(
    outputPath: string,
    videoStartedAtMs: number,
  ): Promise<VideoDescriptor | undefined> {
    try {
      const startOffsetMs = videoStartedAtMs - this.startedAtMs;
      const startedAt = new Date(videoStartedAtMs).toISOString();
      // OBS reports its own local path; the capture service reaches the file
      // under OBS_OUTPUT_DIR (a shared/synced/tailnet mount) by basename.
      const src = this.obsOutputDir
        ? path.join(this.obsOutputDir, path.basename(outputPath))
        : outputPath;
      await this.copyVideoBounded(src, videoPath(this.storageDir, this.callId));
      // Validate defensively so a malformed descriptor degrades to audio-only.
      return VideoDescriptorSchema.parse({
        path: VIDEO_FILENAME,
        startedAt,
        startOffsetMs,
      });
    } catch (err) {
      this.log.warn(
        `failed finalizing video for ${this.callId}; delivering audio-only`,
        err,
      );
      return undefined;
    }
  }

  /**
   * Copy `src` → `dest`, bounded by {@link videoCopyTimeoutMs}. A hung/slow mount
   * rejects at the timeout instead of blocking stop() indefinitely.
   */
  private async copyVideoBounded(src: string, dest: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`video copy timed out after ${this.videoCopyTimeoutMs}ms`),
          ),
        this.videoCopyTimeoutMs,
      );
    });
    try {
      await Promise.race([fs.copyFile(src, dest), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Timestamp-prefixed call ID so `listReadyCalls`'s ascending sort is FIFO by
 * call start. Colons/dots are replaced to keep it filesystem-safe.
 */
function makeCallId(startedAtMs: number, channelId: string): string {
  const stamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, "-");
  return `${stamp}--${channelId}`;
}
