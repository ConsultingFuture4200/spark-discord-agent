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
  createCallManifest,
  ensureCallDir,
  speakerTrackPath,
  writeManifest,
  writeStatus,
  type CallManifest,
  type SpeakerTrack,
} from "@discord-agent/shared";
import type { Logger } from "../logger.js";
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

export interface CallRecorderDeps {
  channel: VoiceBasedChannel;
  /** Base storage dir (`config.storage.dir`). */
  storageDir: string;
  logger: Logger;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
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
    await this.announce();
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
        await this.channel.send(
          "Recording started. This call is being recorded and transcribed locally for a post-call summary.",
        );
      }
    } catch (err) {
      this.log.warn(`failed to announce recording in ${this.channelId}`, err);
    }
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

    const endedAtMs = this.now();
    const endedAtIso = new Date(endedAtMs).toISOString();
    const manifest = createCallManifest({
      callId: this.callId,
      guildId: this.channel.guild.id,
      channelId: this.channelId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      endedAt: endedAtIso,
      tracks,
    });

    try {
      await writeManifest(this.storageDir, manifest);
      await writeStatus(this.storageDir, this.callId, "ready-to-process", endedAtIso);
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

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    return manifest;
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
