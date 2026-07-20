import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  callDir,
  readManifest,
  readStatus,
  summaryMarkdownPath,
  summaryPath,
  transcriptPath,
  writeStatus,
  type CallManifest,
  type MergedTranscript,
} from "@discord-agent/shared";
import { mergeTrackTranscripts } from "./merge.js";
import type {
  CallIngest,
  ChatClient,
  Emailer,
  Logger,
  RawSegment,
  SttBackend,
  SummaryPoster,
} from "./ports.js";
import {
  renderSummaryMarkdown,
  renderTimecodedTranscript,
  TIMECODED_TRANSCRIPT_FILENAME,
} from "./render.js";
import { summarizeCall, type SummarizeOptions } from "./summarize.js";

/**
 * The post-call pipeline for a single call (FR-14 → FR-20): transcribe each
 * per-speaker track, merge on the call timeline, summarize adaptively, persist
 * the artifacts, and deliver to Discord (+ optional email). Advances the call's
 * `status.json` through the state machine and marks it `failed` on any error so
 * the watcher never gets stuck on a bad call.
 */

export interface PipelineDeps {
  baseDir: string;
  stt: SttBackend;
  chat: ChatClient;
  /** The batch (large) model name for summarization. */
  batchModel: string;
  poster: SummaryPoster;
  /** Optional email delivery (adapter from `@discord-agent/agent-tools`). */
  emailer?: Emailer;
  /** Optional gBrain ingest of the call's outputs (`@discord-agent/ingest`). */
  callIngest?: CallIngest;
  /** Clock injection — the pipeline reads it for every status timestamp. */
  now: () => Date;
  logger?: Logger;
  summarizeOptions?: SummarizeOptions;
}

export interface PipelineResult {
  callId: string;
  ok: boolean;
  error?: string;
}

/** Posted in place of a summary when a call captured no speech (LIOTTA-3). */
const NO_SPEECH_NOTICE = "No speech was captured for this call.";

export async function processCall(
  callId: string,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { baseDir, now, logger } = deps;
  const iso = () => now().toISOString();

  // Delivery idempotency: a reclaimed call carries the threadId of any prior
  // successful post and the emailedAt of any prior email, so each leg re-runs at
  // most once. Read at function scope (before the try) so the catch block can
  // forward them too — an intermediate writeStatus must never erase a persisted
  // threadId/emailedAt, or a second crash would strand the call without them and
  // cause a double-delivery on the next reclaim.
  const prior = await readStatus(baseDir, callId).catch(() => undefined);
  const priorThreadId = prior?.threadId;
  const priorEmailedAt = prior?.emailedAt;

  try {
    const manifest = await readManifest(baseDir, callId);
    logger?.info(`Processing call ${callId} (${manifest.tracks.length} tracks).`);

    await writeStatus(
      baseDir,
      callId,
      "transcribing",
      iso(),
      undefined,
      priorThreadId,
      priorEmailedAt,
    );
    const transcript = await transcribeTracks(callId, manifest, deps);
    await writeFile(
      transcriptPath(baseDir, callId),
      JSON.stringify(transcript, null, 2),
      "utf8",
    );

    // Empty/silent call (LIOTTA-3): never feed a zero-segment transcript to the
    // LLM — it would hallucinate a summary of a call that never happened. Post a
    // short notice (idempotently) instead and finish.
    if (transcript.segments.length === 0) {
      logger?.info(`Call ${callId} captured no speech; posting notice.`);
      const threadId =
        priorThreadId ??
        (await deps.poster.postSummary(manifest.channelId, callId, NO_SPEECH_NOTICE))
          .threadId;
      await writeStatus(
        baseDir,
        callId,
        "delivered",
        iso(),
        undefined,
        threadId,
        priorEmailedAt,
      );
      return { callId, ok: true };
    }

    await writeStatus(
      baseDir,
      callId,
      "summarizing",
      iso(),
      undefined,
      priorThreadId,
      priorEmailedAt,
    );
    const summaryResult = await summarizeCall(
      deps.chat,
      deps.batchModel,
      transcript,
      deps.summarizeOptions ?? {},
    );
    if (!summaryResult.ok) {
      throw new Error(`Summarization failed validation: ${summaryResult.error}`);
    }
    const summary = summaryResult.value;
    // M7: when a video was captured, the summary carries a one-line note and a
    // timecoded transcript artifact is written. Both are absent (and the summary
    // is byte-for-byte unchanged) when `manifest.video` is undefined.
    const markdown = renderSummaryMarkdown(summary, manifest.video);

    await writeFile(
      summaryPath(baseDir, callId),
      JSON.stringify(summary, null, 2),
      "utf8",
    );
    await writeFile(summaryMarkdownPath(baseDir, callId), markdown, "utf8");

    // Best-effort (M7 invariant): a failure writing the video-aligned transcript
    // must never block delivery — it degrades to no timecoded artifact, not a
    // failed call.
    if (manifest.video) {
      try {
        await writeFile(
          path.join(callDir(baseDir, callId), TIMECODED_TRANSCRIPT_FILENAME),
          renderTimecodedTranscript(transcript, manifest.video),
          "utf8",
        );
      } catch (err) {
        logger?.warn(
          `Call ${callId}: failed to write timecoded transcript: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // The two delivery legs are tracked independently so a reclaim re-attempts
    // only the unfinished one: a crash after the post + threadId persist but
    // before the email must re-send only the email, never re-post.
    let threadId = priorThreadId;
    let emailedAt = priorEmailedAt;

    // Post leg — skipped if a thread already exists (post idempotency).
    if (threadId) {
      logger?.info(
        `Call ${callId} already posted to thread ${threadId}; skipping re-post.`,
      );
    } else {
      ({ threadId } = await deps.poster.postSummary(
        manifest.channelId,
        callId,
        markdown,
      ));
      // Persist the threadId before the terminal write so a crash between the
      // post and `delivered` cannot cause a reclaimed re-run to post again.
      await writeStatus(
        baseDir,
        callId,
        "summarizing",
        iso(),
        undefined,
        threadId,
        emailedAt,
      );
      logger?.info(`Posted summary for call ${callId} to thread ${threadId}.`);
    }

    // Email leg — independent of the post leg; sent iff configured and not yet
    // sent, so a reclaim that already posted still delivers a missing email.
    if (deps.emailer && !emailedAt) {
      await deps.emailer.sendSummary({
        subject: `Call summary — ${callId}`,
        markdown,
      });
      emailedAt = iso();
      // Persist the email marker before the terminal write, symmetric to the post.
      await writeStatus(
        baseDir,
        callId,
        "summarizing",
        iso(),
        undefined,
        threadId,
        emailedAt,
      );
      logger?.info(`Emailed summary for call ${callId}.`);
    } else if (emailedAt) {
      logger?.info(`Call ${callId} already emailed at ${emailedAt}; skipping re-email.`);
    }

    await writeStatus(
      baseDir,
      callId,
      "delivered",
      iso(),
      undefined,
      threadId,
      emailedAt,
    );

    // Community-memory ingest (PRD Phase 3): best-effort AFTER the terminal
    // write — an ingest failure must never fail a delivered call, and the
    // emitter's per-call idempotency makes a reclaimed re-run a no-op.
    if (deps.callIngest) {
      try {
        await deps.callIngest.ingestCall({ manifest, transcript, summary });
      } catch (ingestErr) {
        logger?.warn(
          `Call ${callId}: gBrain ingest failed: ${
            ingestErr instanceof Error ? ingestErr.message : String(ingestErr)
          }`,
        );
      }
    }
    return { callId, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error(`Call ${callId} failed: ${message}`);
    // Best-effort failure record; swallow a secondary write error. Forward the
    // persisted threadId/emailedAt so a failed write never erases them and a
    // later reclaim stays leg-idempotent.
    await writeStatus(
      baseDir,
      callId,
      "failed",
      iso(),
      message,
      priorThreadId,
      priorEmailedAt,
    ).catch(() => {});
    return { callId, ok: false, error: message };
  }
}

/** Transcribe every track and merge onto the call timeline (FR-14, FR-15). */
async function transcribeTracks(
  callId: string,
  manifest: CallManifest,
  deps: PipelineDeps,
): Promise<MergedTranscript> {
  const perTrack: { track: CallManifest["tracks"][number]; segments: RawSegment[] }[] =
    [];
  for (const track of manifest.tracks) {
    const audioPath = resolveTrackPath(deps.baseDir, callId, track.path);
    deps.logger?.debug(`Transcribing track ${track.userId} (${track.displayName}).`);
    const segments = await deps.stt.transcribeTrack(audioPath);
    perTrack.push({ track, segments });
  }
  return mergeTrackTranscripts(callId, perTrack);
}

/** Resolve a manifest track path (relative to the call dir) to an absolute path. */
function resolveTrackPath(
  baseDir: string,
  callId: string,
  trackPath: string,
): string {
  return path.isAbsolute(trackPath)
    ? trackPath
    : path.join(callDir(baseDir, callId), trackPath);
}
