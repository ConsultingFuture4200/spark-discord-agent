# SPEC: Compliant call video recording (Path A / OBS)

**Status:** v0.1.0 (approved to build)
**Date:** 2026-07-07
**Type:** Addendum to `PRD-discord-agent (1).md` — adds **M7: video recording**.
**Depends on:** the shipped capture + processing pipeline (M1–M3).

## TL;DR

Add **optional** video recording of a call by having the capture bot drive a
**participant-side OBS** instance over **OBS WebSocket**, then align the resulting
video to the existing transcript timeline. This is the ToS-compliant "Path A" from
the design discussion: the bot never receives video from Discord (impossible for a
bot) and never automates a user account's *voice connection*. It only (a) tells OBS
to start/stop, and (b) optionally **moves** an already-connected recorder account
between voice channels. Feature-gated: with `OBS_ENABLED=false` (default) behavior is
byte-for-byte identical to today (audio-only).

## Why this shape

- Discord does not deliver camera/screen-share video to bot accounts — there is no
  API. Capture must therefore come from a real client's rendered output (OBS).
- Automating a user account to *connect* to voice is self-botting (ToS violation).
  Moving an **already-connected** member between channels is a normal bot capability
  (`Move Members` permission) and is compliant. So the recorder account's client must
  already be running and parked in a voice channel; the bot pulls it into the call.
- Talking to OBS over its WebSocket is not a Discord interaction at all — fully
  compliant and the high-value automation seam.

## Non-goals (v0.1.0)

- **Per-speaker video.** OBS captures the composited grid → one `video.mp4` per call.
- **Auto-connecting an offline recorder account.** Impossible/ToS; the client must be
  running and voice-connected for the move to work.
- **Hosted / clickable web deep-links into the video.** v1 stores a local file path and
  emits `[MM:SS]` video timecodes; turning those into URL fragments waits until/if the
  video is served over the tailnet.
- No change to the audio pipeline — audio tracks + transcript are exactly as today.

## Design

### 1. Config (`packages/shared/config.ts`) — new optional `obs` block

Mirrors the existing optional-email pattern: absent → feature off; partially set → hard
`ConfigError`.

| Env key | Meaning | Default |
|---|---|---|
| `OBS_ENABLED` | Master gate. `false` → no OBS/recorder code runs. | `false` |
| `OBS_WEBSOCKET_URL` | OBS WebSocket v5 URL, e.g. `ws://recorder-host:4455`. Required when enabled. | — |
| `OBS_WEBSOCKET_PASSWORD` | OBS WebSocket auth. | *(optional)* |
| `OBS_OUTPUT_DIR` | Folder OBS writes recordings to, **as reachable by the capture service** (local path or a shared/synced/tailnet mount). Used to copy the finished file into the call dir. | *(optional)* |
| `RECORDER_USER_ID` | Discord user ID of the parked recorder account. Set → bot moves it into/out of the call. | *(optional)* |
| `RECORDER_LOBBY_CHANNEL_ID` | Voice channel to move the recorder back to on stop. | *(optional)* |
| `VIDEO_RETENTION_DAYS` | Days to keep `video.mp4` before purge (video is large + sensitive). | = `AUDIO_RETENTION_DAYS` |

`config.obs?: { websocketUrl; websocketPassword?; outputDir?; recorderUserId?; recorderLobbyChannelId? }`.
`config.storage.videoRetentionDays` added.

### 2. Manifest (`packages/shared/manifest.ts`) — new optional `video`

```ts
VideoDescriptorSchema = {
  path: string,          // path in the call dir (e.g. "video.mp4") or the OBS path if not copyable
  startedAt: string,     // ISO wall-clock of the video's first frame (OBS start)
  startOffsetMs: number, // signed int = wallclock(video start) − wallclock(call start)
}
CallManifest.video?: VideoDescriptor   // absent when no video was captured
```

**Alignment math (the core contract):** a transcript segment at `startMs` (relative to
call start) sits at video time `max(0, startMs − video.startOffsetMs)`. If OBS starts
3 s after the call, `startOffsetMs = +3000` and a segment at 10 000 ms is at 7 000 ms
in the video. Pure function `videoTimeForSegmentMs(segmentStartMs, video)` in shared,
unit-tested.

### 3. OBS controller (`packages/capture/src/obs.ts`)

```ts
interface VideoRecorder {
  startRecording(): Promise<{ startedAtMs: number }>;   // OBS StartRecord
  stopRecording(): Promise<{ outputPath: string | null }>; // OBS StopRecord → path
  dispose(): Promise<void>;
}
```

- `ObsVideoRecorder` wraps `obs-websocket-js` (v5: `StartRecord`, `StopRecord`,
  `GetRecordStatus`). Connects lazily; captures `startedAtMs` from the injectable clock
  at the moment StartRecord acks.
- `NoopVideoRecorder` used when `config.obs` is undefined — every call is a no-op, so the
  lifecycle code has no branching.
- **Best-effort, never fatal.** Any OBS connect/request failure is logged and degrades
  that call to audio-only (`video` left unset). OBS problems must never crash an
  always-on recording or block delivery.

### 4. Recorder move (`packages/capture/src/recorder/recorderMove.ts`, used by `VoiceCoordinator`)

- On `startChannel` (after the bot's own join): if `recorderUserId` is set and that member
  **is currently connected to voice in the guild**, `member.voice.setChannel(callChannel)`.
  If not connected → log and skip (a bot cannot originate their connection).
- On `stopChannel`: move the recorder back to `recorderLobbyChannelId` (best-effort).
- Requires the bot to have `Move Members`. Pure decision helper `shouldMoveRecorder(...)`
  is unit-tested; the Discord call is mocked.

### 5. Lifecycle wiring (`CallRecorder`)

- `start()`: after `announce()`, call `videoRecorder.startRecording()`; store
  `videoStartedAtMs`. Failure → log, continue audio-only.
- `stop()`: call `videoRecorder.stopRecording()`; if it returns a path and `outputDir`
  is reachable, copy/move it into the call dir as `video.mp4`; compute
  `startOffsetMs = videoStartedAtMs − startedAtMs`; attach `video` to the manifest.
  All best-effort — a video failure never blocks manifest write / enqueue.
- `announce()`: when OBS is active, the recording notice must also state that **video**
  is being recorded (consent — see below).

### 6. Queue (`packages/shared/queue.ts`)

Add `VIDEO_FILENAME = "video.mp4"` and `videoPath(baseDir, callId)`.

### 7. Processing (`packages/processing`)

- When `manifest.video` is present, write a **timecoded transcript** artifact
  `transcript.timecoded.md` into the call dir: each merged-transcript segment prefixed
  with its `[MM:SS]` **video** timecode (via `videoTimeForSegmentMs`), so the transcript
  reads against the video. Pure renderer, unit-tested.
- Add a one-line note to the delivered summary: `📹 Video recorded (aligned) — <path>`.
  Absent when no video. *(v0.1.0 amendment: the earlier "open at [MM:SS] for key
  moments" sub-item is dropped — the `CallSummary` schema attaches no timecodes to
  individual decisions/action-items, so it would need a speculative schema change or
  text-matching heuristic. The full `transcript.timecoded.md` already delivers the
  aligned index, so the one-line note is sufficient.)*
- **Retention:** the existing audio-purge sweep also purges `video.mp4` after
  `videoRetentionDays`. Transcript artifacts (including the timecoded one) are kept.

### 8. Docs

- `.env.example`: new OBS/recorder/video keys with the tailnet/mount comment.
- `docs/DEPLOY.md`: a "Video recording (optional)" section — the recorder-account +
  OBS-WebSocket + parked-lobby setup, the `Move Members` permission, the reachable
  `OBS_OUTPUT_DIR`, and the **expanded consent notice** (video is now also recorded).

## Consent & compliance (hard requirements)

- The recording announcement must state **video** when OBS is active (NFR-6 / D-7).
- The recorder account is a **real client, operated normally** (parked in a lobby) — its
  voice connection is never automated. Only channel *moves* and OBS are automated.
- Use a **dedicated/disposable** recorder account; document that running a Discord client
  unattended is the operator's responsibility.

## Test plan

- shared: `videoTimeForSegmentMs` offset math (positive/negative/zero, clamp at 0);
  manifest with/without `video` round-trips; config `obs` block absent / full / partial.
- capture: `ObsVideoRecorder` against a mock ws (start/stop/failure→degrade);
  `shouldMoveRecorder` (connected → move, not-connected → skip, no recorderId → skip);
  `CallRecorder` attaches `video` on success and stays audio-only on OBS failure.
- processing: timecoded-transcript render; summary note present iff `video` set;
  retention purges `video.mp4` past `videoRetentionDays` and keeps transcripts.

## Integration with `context-backdrop` (shared OBS)

The always-on recorder account is the host running the **`context-backdrop`** pipeline
(`~/Downloads/context-backdrop-prd-v0.3.0.md`): OBS + `obs-backgroundremoval` + a
browser-source HUD renderer → **virtual camera → Discord**. That means the OBS instance
this feature drives is **shared**, which imposes two rules:

- **This bot only toggles recording** (`StartRecord`/`StopRecord`/`GetRecordStatus`). It
  MUST NOT create/switch scenes, touch sources, or manage the virtual camera —
  context-backdrop owns those. The M7 code is scene-agnostic by construction.
- **What OBS records is an OBS-side scene/output decision, not a code decision.**
  context-backdrop's program output is the *operator + HUD composite* (its outgoing
  feed). Recording the useful *incoming call grid* requires a distinct OBS scene/source
  capturing the Discord window (and typically a separate output). This choice is made in
  OBS setup and documented in `docs/DEPLOY.md`; the bot simply grabs whatever file OBS
  writes to `OBS_OUTPUT_DIR`.

context-backdrop's own whisper transcript is rolling/ephemeral (for its relevance gate);
discord-agent's per-speaker transcription remains the authoritative record. Both coexist.

## Rollback

Set `OBS_ENABLED=false` (or unset the `obs` block). All new code is gated behind
`config.obs`; with it undefined the system is identical to pre-M7.
