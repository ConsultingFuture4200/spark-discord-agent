# PRD: Private Discord Agent with Local LLM (DGX Spark)

**Status:** Draft v1
**Last updated:** 2026-07-03
**Owner:** (you)

---

## 1. Summary

A single always-on AI agent that lives as a member of a private Discord server, backed entirely by models running locally on a DGX Spark. The agent has its own identity (bot account, avatar, email inbox), acts on email and direct messages, and automatically joins voice calls to record, transcribe, and produce a written breakdown afterward. No conversation content leaves the owner's hardware except where Discord's own transport requires it.

The defining constraint and design principle: **all model inference is local, and the heaviest work (transcription and summarization) happens after a call ends, as a batch job.** This plays directly to the Spark's strengths (large unified memory, strong batched/prefill throughput) and away from its one weakness (memory bandwidth, which only hurts interactive token generation on large models).

---

## 2. Goals and non-goals

### Goals
1. Present the agent as a first-class member of the server (name, avatar, presence, its own email address).
2. Read and act on the agent's email inbox (send, reply, take instructed actions).
3. Read and respond to Discord DMs sent to the agent.
4. Automatically join server voice channels when a call is active, and participate in the call's text chat.
5. Record each call with per-speaker separation, transcribe locally, and post a dual summary (whole-call plus per-speaker) to the channel and optionally by email.
6. Keep all inference local to the Spark; keep all stored audio and transcripts on the owner's hardware.

### Non-goals (v1)
- Real-time spoken voice output from the agent (no text-to-speech in the call). Interaction during a call is text-only.
- Joining group-DM or 1:1 DM calls (not available to bot accounts; explicitly out of scope).
- A tagless "human-looking" account (would require a self-bot, which violates Discord's Terms of Service and is excluded).
- Multi-server / public distribution. This is a single private deployment.
- Model training or fine-tuning on the Spark (inference only for v1).

---

## 3. Background and key constraints

**Hardware.** The DGX Spark provides 128 GB unified memory and can run models up to ~200B parameters locally, but its LPDDR5x memory bandwidth (~273 GB/s) is the bottleneck for interactive token generation on large models. Prefill and batched throughput are strong. Implication: run summarization and transcription as post-call batch jobs, and favor smaller/MoE models for any interactive text.

**Discord bot identity.** A bot account can carry its own name, avatar, presence, and can post like any member, but it always shows a non-removable APP/BOT badge. In a private channel where members know it is an agent, this is acceptable. Driving a real user account to remove the badge (self-botting) is against ToS and is out of scope.

**Voice is server-voice-channel only.** Bots can join and receive audio in server voice channels. They cannot join group-DM or direct-call audio. "Join every call" therefore means "join active server voice channels," triggered by voice-state events.

**DAVE / E2EE is mandatory.** Since March 2, 2026, Discord enforces end-to-end encryption (the DAVE protocol) on all voice/video, with the unencrypted fallback path being removed. Any stack that joins a call must implement DAVE. Both candidate stacks now do (see Section 8).

**Consent.** Recording participants' audio must be known to all members. In a private group of consenting members this is straightforward, but the agent must announce recording state, and recording behavior should be opt-in per channel.

**What is and isn't private.** Model inference, stored audio, and transcripts stay on the Spark. Voice audio in transit is end-to-end encrypted by Discord (the agent is an authorized endpoint that decrypts its own incoming streams). Discord text (channel messages, DMs) is *not* end-to-end encrypted and passes through Discord's servers in plaintext; this is inherent to the platform and should be documented for users.

---

## 4. Users

- **Channel members:** a small, known, private group. They talk in text and voice, DM the agent, and receive summaries. They consent to recording.
- **Owner/operator:** runs the Spark, configures which channels auto-record, manages the bot account and email inbox, sets the models.

---

## 5. Functional requirements

### 5.1 Identity and presence
- FR-1: The agent runs as a Discord bot application with a configured display name and avatar.
- FR-2: The agent maintains an online presence and appears in the member list.
- FR-3: The agent owns a dedicated email address with an inbox it can read and send from.

### 5.2 Email
- FR-4: The agent polls (or receives webhooks for) new mail and can feed message content into its reasoning loop.
- FR-5: The agent can compose and send email, including replies in existing threads.
- FR-6: Email is exposed to the model as a tool (send / read / list), with the model deciding when to use it.

### 5.3 Direct messages
- FR-7: The agent receives DMs addressed to it and can reply.
- FR-8: DM handling reuses the same reasoning loop and tool set as channel interaction.

### 5.4 Voice call handling
- FR-9: When a monitored voice channel becomes active (member count crosses a configurable threshold, or a configured trigger user/role joins), the agent auto-joins.
- FR-10: On joining, the agent announces in the associated text chat that recording has started.
- FR-11: The agent records **one audio track per speaker** (per-user separation) for the duration of the call.
- FR-12: The agent can post text messages in the call's text chat while the call is ongoing.
- FR-13: When the channel empties (or a stop condition is met), the agent stops recording and leaves.

### 5.5 Transcription and diarization
- FR-14: Each per-speaker track is transcribed locally with faster-whisper, producing text with segment timestamps.
- FR-15: Per-speaker transcripts are merged by timestamp into a single chronological, speaker-labeled transcript.
- FR-16: Speaker labels use real display names resolved from Discord voice-state, not "Speaker 1."

### 5.6 Summarization and delivery
- FR-17: The merged transcript is sent to the local LLM to produce a structured result containing:
  - a **full-call section**: overview, key topics, decisions, open questions, and a consolidated action-item list with owners;
  - a **per-speaker section**: for each participant, their contributions, positions/concerns, and their action items.
- FR-18: The model returns JSON (not prose) so the result can be rendered cleanly into Discord and email.
- FR-19: The summary is posted to the channel (in a thread) and optionally emailed via the agent's inbox.
- FR-20: Raw transcript and summary are stored locally, keyed by call.

---

## 6. Non-functional requirements

- NFR-1 (Privacy): All model inference local to the Spark. No third-party AI APIs. Audio and transcripts stored only on owner hardware.
- NFR-2 (Availability): The agent is always-on and survives host reboots (runs as a managed service).
- NFR-3 (Resilience): Voice disconnects, dropped packets, and reconnects are handled without losing an in-progress recording where avoidable.
- NFR-4 (Latency): Post-call processing is batch; a summary within a few minutes of call end is acceptable. Interactive text (DMs, channel replies) should feel responsive, which constrains the interactive model size.
- NFR-5 (Portability/ARM): All components must build and run on the Spark's ARM64 architecture, including native dependencies.
- NFR-6 (Transparency): Recording state is always visible to participants.

---

## 7. System architecture

The system splits into two services plus the local inference layer. This mirrors the proven recorder/processor separation used by mature recording bots, and keeps the latency-sensitive audio path independent from the heavy batch work.

```
                    Discord (gateway + E2EE voice via DAVE)
                                  |
              +-------------------+--------------------+
              |                                        |
   [1] Capture / Presence service          (text events, DMs, voice-state)
       - bot account, presence
       - DM + channel text handling
       - auto-join voice on trigger
       - per-speaker audio capture (DAVE)
       - writes per-user tracks + timing manifest
              |
              v  (per-speaker audio files + manifest, over filesystem/queue)
   [2] Processing service
       - faster-whisper transcription (per track, timestamps)  --> Spark GPU
       - timestamp merge -> speaker-labeled transcript
       - LLM dual summary (JSON)                                --> Spark GPU
       - post to channel thread + email
       - local storage of transcript + summary
              |
              v
   [3] Local inference on the Spark
       - faster-whisper (STT)
       - LLM served via OpenAI-compatible endpoint (vLLM or Ollama)
```

**Inference endpoints.** The LLM is served behind an OpenAI-compatible HTTP endpoint (vLLM or Ollama), so summarization is a standard chat-completions call with the base URL pointed at the Spark. Transcription runs faster-whisper locally, either as a small HTTP service or in-process in the processing service.

**Model selection.** Summarization: a mid-size dense or MoE model that fits comfortably in unified memory; since it is batch, larger is acceptable. Interactive text (DMs/channel): a smaller, fast model for responsiveness. Transcription: a medium/large Whisper variant; accuracy over speed since it is post-call.

---

## 8. Technology stack decision

DAVE support is present in both candidate stacks, so it no longer forces the choice:

- **@discordjs/voice (TypeScript):** implemented DAVE in 0.19.0 (Aug 2025), hardened in 0.19.1 / 0.19.2 (Mar 2026). Requires bumping off the older 0.18.x line and pulling native deps (the DAVE module plus a sodium crypto library), which must build on ARM64.
- **Songbird (Rust):** supports DAVE, provides per-user jitter buffers that reorder and synchronize multi-speaker audio, runs the audio pipeline in-process with ffmpeg removed, and ships as a single static binary. Scripty (Rust) is a production precedent for offline-STT Discord bots.

### Recommendation

**Hybrid, with a clear default.** The heavy compute (Whisper, LLM) runs as separate services regardless of bot language, so Rust offers little whole-system throughput benefit. Its real advantage is concentrated in the capture layer, which is also the hardest part to get right (multi-speaker, packet reordering, DAVE, always-on stability).

Two viable paths:

- **Path A - All TypeScript (fastest to working system).** Fork the existing meeting-bot scaffold, bump `@discordjs/voice` to `^0.19.2`, replace its mix-down capture with per-speaker track writing, add an auto-join voice-state handler, and rewire the two isolated AI functions (`transcribe`, `summarize`) to the Spark. Reuses a large amount of existing, readable code. Recommended for the first working end-to-end version.

- **Path B - Rust capture + light processing (more robust long-term).** Build the capture/presence service on Serenity + Songbird for superior multi-speaker receive, single-binary ARM deployment, and lower always-on resource use. Keep processing/orchestration wherever fastest.

**Proposed plan:** start on **Path A** to reach a working system quickly and validate the full pipeline (especially DAVE + per-speaker capture on ARM). Treat the **capture service specifically** as the candidate to migrate to **Rust/Songbird (Path B)** if/when capture robustness, multi-speaker fidelity, or resource use justify it. The two-service split in Section 7 makes this migration possible without touching the processing side.

### Borrowing map
- **Scaffold, command structure, state machine, stop -> transcribe -> summarize -> post flow, isolated AI functions:** from the existing TypeScript meeting bot.
- **Per-speaker track model and auto-record trigger logic (concepts):** from Craig, reimplemented lean rather than adopting its full self-host stack.
- **Offline-STT-at-scale precedent (if going Rust):** Scripty.

---

## 9. Dependencies and risks

| # | Item | Risk | Mitigation |
|---|------|------|------------|
| D-1 | DAVE native module builds on ARM64 | Medium | Verify ARM prebuild/compile early, before deep work |
| D-2 | Sodium crypto lib builds on ARM64 | Low | Standard on ARM; verify at install |
| D-3 | faster-whisper on Spark GPU (ARM+CUDA) | Low | CUDA is native on Spark; validate model load |
| D-4 | LLM served OpenAI-compatible on Spark | Low | vLLM and Ollama both documented on Spark |
| D-5 | Multi-speaker capture fidelity | Medium | Per-user tracks; Songbird jitter buffers if Path B |
| D-6 | Interactive latency on large model | Medium | Use small model for interactive; keep big model for batch |
| D-7 | Recording consent / disclosure | Policy | Per-channel opt-in + visible recording announcement |
| D-8 | Discord text is not E2EE | Inherent | Document clearly; sensitive content stays out of text |

---

## 10. Data and storage

- Per-call directory on the Spark containing: per-speaker audio tracks, timing manifest, merged transcript (text), and summary (JSON + rendered markdown).
- Retention configurable; default retain locally, owner controls deletion.
- No cloud storage by default.

---

## 11. Milestones

- **M0 - Environment validation:** confirm DAVE + sodium build on ARM; confirm faster-whisper and the LLM endpoint run on the Spark. Exit: a bot account joins a test voice channel over DAVE and receives audio.
- **M1 - Capture core:** auto-join on voice-state trigger; per-speaker recording; recording announcement; clean stop. Exit: per-speaker audio files produced for a real call.
- **M2 - Local transcription + diarization:** per-track faster-whisper; timestamp merge; real display-name labels. Exit: accurate speaker-labeled transcript from M1 audio.
- **M3 - Dual summary + delivery:** LLM produces JSON full + per-speaker summary; posted to thread; stored locally. Exit: end-to-end call -> posted summary.
- **M4 - Email + DM tools:** inbox read/send tool; DM handling; wired into the reasoning loop. Exit: agent acts on an email and answers a DM.
- **M5 - Hardening / always-on:** service management, reconnect handling, retention config. Exit: runs unattended across reboots.
- **(Optional) M6 - Rust capture migration:** port the capture service to Serenity + Songbird if warranted.

---

## 12. Open questions

1. One interactive model plus one batch model, or a single model for both? (Depends on measured latency on the Spark.)
2. Summary generation: single LLM pass or two-pass (summary, then per-speaker) for long calls?
3. Email provider: self-hosted inbox vs. a provider with IMAP/SMTP or API access?
4. Auto-join policy per channel: minimum member count, specific trigger users/roles, or manual arm/disarm?
5. Retention defaults for audio vs. transcripts vs. summaries.
6. Confirm ARM prebuilds exist for the DAVE native dependency (decides how much M0 build work is needed).

---

## 13. Success criteria

- The agent reliably joins active monitored voice channels and produces a correct, speaker-labeled transcript and a useful dual summary within a few minutes of call end.
- The agent answers DMs and acts on email without manual intervention.
- No conversation content is sent to any third-party model service.
- The system runs unattended on the Spark across reboots.
