# Build Decisions — Discord Agent (resolves PRD §12 Open Questions)

**Status:** v1 (best-guess defaults, revisit after Spark measurement)
**Date:** 2026-07-05
**Basis:** PRD-discord-agent (1).md + meetily reference (local Whisper + Ollama pipeline)

Meetily (Tauri/Rust/Next.js desktop app) is a **reference** for the local-STT +
local-LLM-summary pattern only. The deliverable is the **Discord agent** in the PRD.
Stack: **Path A — all-TypeScript**, pnpm workspaces, per PRD §8 recommendation.

## Resolved open questions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | One interactive + one batch model, or single? | **Two models**, both via one Ollama OpenAI-compatible endpoint. Interactive: small fast model (`qwen2.5:7b`); batch summary: large (`qwen2.5:32b` / MoE). Configurable per role. | NFR-4 constrains interactive size; batch can be large. Single endpoint, two model names = trivial to collapse to one later. |
| 2 | Single-pass or two-pass summary? | **Adaptive.** Transcript under threshold (~8k tokens) → one structured JSON call. Over threshold → map-reduce: chunk → partial summaries → reduce, then a second per-speaker pass. | Long calls overflow context; short calls shouldn't pay the two-pass tax. |
| 3 | Email provider? | **Provider-agnostic IMAP (read) + SMTP (send)** via env config. No mail server built. | Simplest; email transport inherently leaves the box regardless. Keeps privacy boundary at "inference + storage local." |
| 4 | Auto-join policy? | **Per-channel allowlist**, each armed channel triggers on **≥1 non-bot human present** (default) OR a configured trigger role/user. Manual `arm`/`disarm` slash commands override. | Matches FR-9; safe default (won't join un-armed channels); operator control. |
| 5 | Retention defaults? | **Audio: 7 days then auto-purge. Transcript + summary: retained indefinitely.** All configurable. | Audio is large + most sensitive; text artifacts are small + useful. |
| 6 | ARM prebuilds for DAVE native dep? | **Assume compile-from-source on ARM64.** Pin `@discordjs/voice ^0.19.2`, ship an M0 `verify-native.sh` that builds the DAVE module + libsodium and joins a test VC. | Can't verify prebuilds blind; make the build explicit and fail fast at install. |

## Architecture (per PRD §7)

Two services + local inference, split so latency-sensitive capture is isolated from heavy batch work:

- `packages/shared` — types (call manifest, transcript, summary JSON schema), config loader, zod schemas.
- `packages/capture` — Discord bot: presence, DM/channel text, voice-state auto-join, per-speaker DAVE capture → writes per-user tracks + timing manifest to a call dir, enqueues for processing.
- `packages/processing` — watches the queue: faster-whisper per-track STT → timestamp merge → dual JSON summary via Ollama → post to Discord thread + optional email → local storage.
- `packages/agent-tools` — email (IMAP/SMTP) + DM reasoning loop + tool interface (shared by capture text handling and processing delivery).
- `infra/` — systemd units, install/verify scripts, `.env.example`.

Queue between services: filesystem-based (call dir + a `status.json` state file), watched by processing. No external broker (single-host).

## Deferred / explicitly not built in v1
- Real-time TTS in-call (PRD non-goal).
- Rust/Songbird capture migration (PRD M6, optional).
- Model fine-tuning.
