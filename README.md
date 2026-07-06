# Discord Agent (local-inference, DGX Spark)

A private, always-on Discord agent whose model inference runs entirely on local
hardware (a DGX Spark). It joins server voice channels, records per-speaker audio
over Discord's E2EE (DAVE) voice, transcribes locally with faster-whisper, and
produces a dual (full-call + per-speaker) JSON summary via a local Ollama
OpenAI-compatible endpoint — posting the result to a Discord thread and optionally
by email. It also handles DMs and email as agent tools.

See `PRD-discord-agent (1).md` for the product spec and `DECISIONS.md` for the
resolved build decisions. Stack: **Path A — all-TypeScript**, pnpm workspaces,
strict TS.

## Architecture

Two services plus the local inference layer, connected by a filesystem queue
(one directory per call). See `DECISIONS.md` for detail.

| Package | Role |
|---|---|
| `packages/shared` | Contracts imported by everything: config loader, call manifest, transcript, summary JSON schema, filesystem-queue helpers (this is the only package built so far). |
| `packages/capture` *(planned)* | Discord bot: presence, DM/channel text, voice-state auto-join, per-speaker DAVE capture → writes tracks + manifest, enqueues for processing. |
| `packages/processing` *(planned)* | Watches the queue: faster-whisper STT → timestamp merge → dual JSON summary via Ollama → posts to thread + email → local storage. |
| `packages/agent-tools` *(planned)* | Email (IMAP/SMTP) + DM reasoning loop + shared tool interface. |

## Requirements

- Node.js >= 20 (developed on 24)
- pnpm >= 11 (`corepack enable` then `corepack prepare pnpm@11 --activate`)
- For the full system (not needed to build/test `shared`): a DGX Spark (ARM64 +
  CUDA) running Ollama and faster-whisper, and a Discord bot application.

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in Discord / Ollama / email / storage values
```

Configuration is validated at startup by `loadConfig()` in `@discord-agent/shared`;
see `.env.example` for every key and its default.

## Build / run / test

Commands run at the repo root and fan out to every workspace package.

```bash
pnpm build       # tsc build of every package (emits dist/)
pnpm test        # vitest run across every package
pnpm typecheck   # type-check without emit
pnpm clean       # remove dist/ + build info
```

Per-package (example, the shared contracts):

```bash
pnpm --filter @discord-agent/shared build
pnpm --filter @discord-agent/shared test
```

There is no run target yet — the capture and processing services are the next
milestones (PRD §11 M1–M3). Building and testing `packages/shared` works today.

## Deployment (Spark, always-on)

Operability lives in `infra/` and `docs/DEPLOY.md`. On the Spark:

```bash
cp .env.example .env && $EDITOR .env   # configure
infra/verify-native.sh                 # M0 gate: DAVE/opus/sodium build + Ollama/whisper respond
infra/install.sh                       # pnpm install + build, then install & enable the systemd services
```

| Path | Purpose |
|---|---|
| `infra/verify-native.sh` | PRD §11 M0 check — proves `@discordjs/voice`'s DAVE native module + libsodium + opus build/load on ARM64, and that the Ollama endpoint + faster-whisper respond. Fails fast. |
| `infra/install.sh` | Idempotent, ARM64-aware installer: build the workspace, render + install the two systemd units, enable on boot (NFR-2). |
| `infra/systemd/*.service.in` | Templated units for the capture and processing services (rendered per-host by `install.sh`). |
| `docs/DEPLOY.md` | Full deploy runbook: `.env`, verify, install, arming a channel, consent/recording disclosure, retention, and the privacy boundary (text is **not** E2EE). |

## Privacy note

Model inference, stored audio, and transcripts stay on the owner's hardware.
Discord **text** (channel messages, DMs) is *not* end-to-end encrypted and passes
through Discord's servers in plaintext; email transport also leaves the box by
nature. Keep sensitive content out of text and email. Voice audio in transit is
E2EE via DAVE.
