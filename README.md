<div align="center">

# Spark Discord Agent

**A private, always-on Discord agent whose AI runs entirely on your own hardware.**

It joins voice channels, records each speaker separately, transcribes locally with
faster-whisper, and posts a structured meeting summary — without any conversation
content ever reaching a third-party AI service.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220?logo=pnpm&logoColor=white)
![Tests](https://img.shields.io/badge/tests-118%20passing-brightgreen)

</div>

---

## Overview

The Spark Discord Agent is a first-class member of a small, private Discord server.
It has its own name, avatar, and email inbox; it answers DMs and email; and when a
monitored voice call starts, it joins, records **one audio track per speaker**, and —
after the call ends — produces a transcript and a dual (full-call + per-speaker)
summary that it posts back to the channel.

Every model runs on **local hardware** (built around an NVIDIA DGX Spark): [Ollama](https://ollama.com)
for text, [faster-whisper](https://github.com/SYSTRAN/faster-whisper) for
transcription. The design principle is that the heaviest work — transcription and
summarization — runs **after** a call as a batch job, which plays to the Spark's
strengths and keeps interactive chat responsive.

> [!IMPORTANT]
> **No conversation content is sent to any third-party AI API.** Model inference,
> stored audio, and transcripts stay on your hardware. See [Privacy boundary](#privacy-boundary)
> for the one thing that is *not* private (Discord text is not end-to-end encrypted).

## Features

- **Per-speaker voice recording** — captures a separate track for each participant over
  Discord's end-to-end-encrypted (DAVE) voice, then merges them into one chronological,
  speaker-labeled transcript using real display names.
- **Local transcription** — faster-whisper on the Spark GPU; no audio leaves the box.
- **Dual meeting summaries** — a full-call section (overview, key topics, decisions, open
  questions, action items) plus a per-speaker section, returned as validated JSON and
  rendered to Discord and optionally email.
- **Adaptive summarization** — short calls use a single LLM pass; long calls fall back to
  a hierarchical map-reduce that stays within the model's context window.
- **Opt-in, per-channel auto-join** — the agent only joins armed channels, announces when
  recording starts, and leaves when the channel empties.
- **Email + DM tools** — reads and sends email (IMAP/SMTP) and answers DMs through a shared
  tool-calling reasoning loop.
- **Always-on & resilient** — runs as two systemd services that survive reboots, with
  crash recovery, atomic state writes, and idempotent delivery (a crash never double-posts).
- **Runs on or off the Spark** — the bot host only needs to reach the Spark's inference
  endpoints over [Tailscale](https://tailscale.com), so it can run on any tailnet machine.

## Architecture

Two services plus the local inference layer, connected by a filesystem queue (one
directory per call). Splitting latency-sensitive capture from heavy batch processing
keeps the audio path independent of transcription and summarization.

```
                 Discord (gateway + E2EE voice via DAVE)
                                 │
        ┌────────────────────────┴────────────────────────┐
        │                                                  │
   capture service                                  text · DMs · voice-state
   ├─ presence, DM/channel text                            │
   ├─ auto-join armed voice channels                        │
   └─ per-speaker capture ─► per-user tracks + manifest     │
        │                                                   │
        ▼  (filesystem queue: one dir per call)             │
   processing service                                       │
   ├─ faster-whisper STT (per track)  ──────────►  Spark GPU
   ├─ timestamp merge ─► speaker-labeled transcript         │
   ├─ dual JSON summary (adaptive)    ──────────►  Ollama (Spark)
   └─ post to Discord thread + optional email               │
                                                            │
   agent-tools ── email (IMAP/SMTP) + reasoning loop ◄──────┘
```

| Package | Role |
|---|---|
| [`packages/shared`](packages/shared) | Contracts imported by everything: config loader, call manifest, transcript types, summary JSON schema, and the filesystem-queue helpers. |
| [`packages/capture`](packages/capture) | Discord bot — presence, DM/channel text, voice-state auto-join, per-speaker DAVE capture, writes tracks + manifest and enqueues each call. |
| [`packages/processing`](packages/processing) | The batch worker — watches the queue, runs faster-whisper, merges transcripts, generates the dual summary, and delivers it. |
| [`packages/agent-tools`](packages/agent-tools) | Email (IMAP read / SMTP send) and the tool-calling reasoning loop shared by DM handling and email delivery. |
| [`packages/ingest`](packages/ingest) | gBrain community-memory emitters — converts messages, edits/deletes, members, call outputs, and media attachments into memory nodes + typed graph edges over gBrain's HTTP API, with consent gates and the `/ask` fused-recall renderer. |

## Prerequisites

- **Node.js >= 20** (developed on 24) and **pnpm >= 11**
  (`corepack enable && corepack prepare pnpm@11 --activate`)
- A **Discord bot application** (token + application id) added to your private server
- For the full pipeline: an **Ollama** endpoint and a **faster-whisper** service on the
  Spark, reachable over Tailscale

> [!NOTE]
> You can build, test, and develop the whole codebase without any of the runtime
> infrastructure. The Spark, Ollama, and faster-whisper are only needed to actually
> record and summarize a call.

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill in Discord / Ollama / Whisper / email values
```

Configuration is validated at startup by `loadConfig()` in `@discord-agent/shared`;
`.env.example` documents every key and its default.

```bash
pnpm build        # tsc build of every package (emits dist/)
pnpm test         # vitest across every package
pnpm typecheck    # type-check without emit
pnpm clean        # remove dist/ + build info
```

Work on a single package with a filter:

```bash
pnpm --filter @discord-agent/processing test
```

## Running the agent

The agent runs as two long-lived services. On your chosen host:

```bash
cp .env.example .env && $EDITOR .env   # 1. configure
infra/verify-native.sh                 # 2. M0 gate: native modules + Ollama/whisper reachable
infra/install.sh                       # 3. build, install, and enable the systemd services
```

Then **arm a channel** — auto-record is opt-in, so the agent never joins an unarmed
channel:

- Pre-arm at boot via `DISCORD_AUTORECORD_CHANNEL_IDS`, or
- Arm/disarm live with the `/arm` and `/disarm` slash commands.

By default the agent joins an armed channel when at least one non-bot human is present,
announces that recording has started, and leaves when the channel empties. A transcript
and summary are posted within a few minutes of the call ending.

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for the full runbook: host placement,
systemd operation, GPU access, retention, and consent requirements.

## How it works

1. **Trigger** — a voice-state event fires when someone joins an armed channel; the
   capture service joins and announces recording.
2. **Capture** — each speaker's Opus stream is decoded and written to its own WAV track
   with a timing offset; a call manifest records who spoke and when.
3. **Enqueue** — on stop, the call directory is marked `ready-to-process`.
4. **Transcribe** — the processing service runs faster-whisper on each track and merges
   the segments into one chronological, speaker-labeled transcript.
5. **Summarize** — the transcript goes to the batch LLM, which returns a JSON summary
   validated against the shared schema (single-pass, or map-reduce for long calls).
6. **Deliver** — the summary is posted to a Discord thread and optionally emailed;
   audio is auto-purged after a retention window while transcripts and summaries are kept.

## Configuration

Full reference lives in [`.env.example`](.env.example). The essentials:

| Group | Keys | Notes |
|---|---|---|
| Discord | `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID` | required |
| Auto-record | `DISCORD_AUTORECORD_CHANNEL_IDS`, `DISCORD_TRIGGER_ROLE_IDS`, `DISCORD_TRIGGER_USER_IDS` | comma-separated; empty = nothing records until armed |
| Ollama | `OLLAMA_BASE_URL`, `OLLAMA_INTERACTIVE_MODEL`, `OLLAMA_BATCH_MODEL` | endpoint over Tailscale; two model roles |
| Whisper | `WHISPER_BASE_URL`, `WHISPER_MODEL`, `WHISPER_COMPUTE_TYPE` | faster-whisper STT service |
| Email *(optional)* | `IMAP_*`, `SMTP_*`, `AGENT_EMAIL_FROM` | all-or-nothing block; partial config is a hard error |
| Storage | `STORAGE_DIR`, `AUDIO_RETENTION_DAYS` | audio purged after N days; text kept |
| gBrain ingest *(optional)* | `INGEST_ENABLED`, `GBRAIN_BASE_URL`, `INGEST_CONSENT_PATH`, `INGEST_STATE_DIR`, `INGEST_REGION` | off by default; see below |

## Community memory (gBrain ingest)

With `INGEST_ENABLED=true`, the agent feeds an opt-in slice of the server into
[gBrain](../gbrain) (the single-writer memory service in front of TriDB) and
answers `/ask <question>` with fused graph-aware recall, including the engine's
honesty probes (`graph_censored`, `termination_reason`) in a footer.

- **Consent is opt-in and default-DENY.** `INGEST_CONSENT_PATH` points at a JSON
  file — `{ "allowChannels": ["<channel id>", ...], "optOutMembers": ["<user id>", ...] }`.
  Channels not allowlisted are never ingested; a missing file ingests nothing.
  Opted-out members' messages, mentions, and call speech are all excluded at
  emit time. Voice ingestion keeps the existing announce-on-record behavior.
- **What gets ingested:** messages (with authored / in_channel / in_thread /
  replies_to / mentions edges), member identities, and each delivered call's
  transcript chunks, summary, decisions, and action items. Edits become new
  nodes superseding the original (append-only); deletions become queued
  tombstone requests. Video/image attachments emit a media-ingest request
  pointing gBrain's media pipeline at the URL.
- **State:** `INGEST_STATE_DIR` holds the source-URI → memory-id map that makes
  ingest idempotent and lets later events edge against earlier ones.

## Privacy boundary

> [!WARNING]
> **Discord text is not end-to-end encrypted.** Channel messages, DMs, and the posted
> summaries pass through Discord's servers in plaintext, and email (IMAP/SMTP) leaves
> the box by nature. The privacy guarantee is *"inference and storage are local,"* not
> *"text is private."* Keep sensitive content out of text and email.

- **Local:** all model inference and all stored audio/transcripts/summaries stay on your
  hardware — no third-party AI APIs are ever called.
- **Voice in transit:** end-to-end encrypted via Discord's DAVE protocol; the agent
  decrypts only its own incoming streams.
- **Recording is disclosed:** the agent announces when recording starts and carries a
  non-removable Discord APP/BOT badge, so participants always know it is present.

## Resources

- [`PRD-discord-agent (1).md`](PRD-discord-agent%20%281%29.md) — the product spec
- [`DECISIONS.md`](DECISIONS.md) — resolved build decisions and resilience invariants
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deployment runbook
- [discord.js](https://discord.js.org) · [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) — Discord + voice/DAVE
- [Ollama](https://ollama.com) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — local inference
