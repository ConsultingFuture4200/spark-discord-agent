# Deploying the Discord Agent (DGX Spark)

How to configure, verify, and run the agent as two always-on systemd services on
the Spark. Assumes the repo is checked out on the Spark (ARM64) as the operator
user, and that Ollama + faster-whisper run locally. See `PRD-discord-agent (1).md`
(§7 architecture, §11 milestones) and `DECISIONS.md` for the why.

TL;DR:

```bash
cp .env.example .env && $EDITOR .env   # 1. configure
infra/verify-native.sh                 # 2. M0 gate (native + endpoints)
infra/install.sh                       # 3. build + install + enable services
# then arm a channel with /arm in Discord (see "Arming a channel")
```

---

## 0. Host placement & networking

The two services do not have to run on the Spark. They only need to reach the
Spark's inference endpoints — Ollama (`OLLAMA_BASE_URL`) and the faster-whisper
service (`WHISPER_BASE_URL`) — which are exposed over **Tailscale**. Point those
envs at the Spark's Tailscale address (MagicDNS name like `spark`, or its
`100.x.y.z` address); localhost is only correct when a service is co-located on
the Spark.

Because of this, **ARM64 is optional, not mandatory**. The ARM64-specific build
steps below (`infra/verify-native.sh`, compiling the capture service's native
DAVE/opus/sodium addons from source) apply **only if you co-locate the bot on the
Spark**. Running the bot on an x86 tailnet host that reaches the Spark's Ollama +
whisper endpoints over Tailscale is a supported deployment; on such a host the
native modules use their platform's normal build/prebuilds and the M0 ARM64 gate
does not apply.

---

## 1. Prerequisites

- **Node.js >= 20** and **pnpm >= 11** (`corepack enable && corepack prepare pnpm@11 --activate`).
- **Build toolchain** for the native addons (DAVE/opus/sodium compile from source
  on ARM64): `sudo apt-get install -y build-essential python3 cmake`.
- **Ollama** running with an OpenAI-compatible endpoint, models pulled
  (`ollama pull qwen2.5:7b && ollama pull qwen2.5:32b`).
- **faster-whisper** available on the Spark GPU — either importable in `python3`
  (`pip install faster-whisper`) or exposed as an HTTP service (set
  `WHISPER_HEALTH_URL`, below).
- A **Discord bot application** (token, application id) added to the private guild
  with the Guilds, Guild Voice States, Guild Messages, Message Content, and Direct
  Messages intents, and permission to connect/speak in voice + post in text.

## 2. Configure `.env`

Copy the template and fill it in. `.env` is gitignored; never commit real secrets.

```bash
cp .env.example .env
```

Every key, its default, and validation lives in `.env.example` and is enforced at
startup by `loadConfig()` in `@discord-agent/shared`. Key groups:

| Group | Keys | Notes |
|---|---|---|
| Discord | `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID` | required |
| Auto-record | `DISCORD_AUTORECORD_CHANNEL_IDS`, `DISCORD_TRIGGER_ROLE_IDS`, `DISCORD_TRIGGER_USER_IDS` | comma-separated; empty = nothing auto-records until armed |
| Ollama | `OLLAMA_BASE_URL`, `OLLAMA_INTERACTIVE_MODEL`, `OLLAMA_BATCH_MODEL`, `OLLAMA_API_KEY` | endpoint on the Spark |
| Whisper | `WHISPER_MODEL`, `WHISPER_COMPUTE_TYPE` | in-process STT config |
| Email (optional) | `IMAP_*`, `SMTP_*`, `AGENT_EMAIL_FROM` | all-or-nothing block; partial config is a hard error |
| Storage/retention | `STORAGE_DIR`, `AUDIO_RETENTION_DAYS`, `VIDEO_RETENTION_DAYS` | see [Retention](#5-retention) |
| Video (optional) | `OBS_ENABLED`, `OBS_WEBSOCKET_URL`, `OBS_WEBSOCKET_PASSWORD`, `OBS_OUTPUT_DIR`, `RECORDER_USER_ID`, `RECORDER_LOBBY_CHANNEL_ID` | OFF by default; see [Video recording](#9-video-recording-optional) |
| Runtime | `LOG_LEVEL` | |

Optional keys read by tooling but not in the base schema:

- `WHISPER_HEALTH_URL` — if you run faster-whisper as a separate HTTP service,
  set its health URL so `verify-native.sh` checks the service instead of the
  local Python import.

**systemd `.env` format note:** the units load `.env` via `EnvironmentFile=`, and
systemd parses it as literal `KEY=value` lines (no shell expansion). The template
`.env.example` is already in this form. If a value contains spaces, wrap it in
double quotes. Do not use `export`, and avoid inline `#` in values.

## 3. Verify the environment (M0 gate)

Run **before** installing services. This is PRD §11 M0 — it fails fast if the
DAVE native module, libsodium, opus, the Ollama endpoint, or faster-whisper are
not usable on this host.

```bash
infra/verify-native.sh
```

It checks, in order:

1. ARM64 arch + Node >= 20.
2. `@snazzah/davey` (DAVE/MLS), `sodium-native` (libsodium), `@discordjs/opus`
   **build and load** — proven in an isolated scratch install pinned to
   `@discordjs/voice@^0.19.2`, so it does not depend on the app being built yet.
3. `GET {OLLAMA_BASE_URL}/models` responds; warns if a configured model is not
   yet pulled.
4. faster-whisper: hits `WHISPER_HEALTH_URL` if set, else confirms the Python
   library imports and a GPU is visible.

Escape hatches: `SKIP_NATIVE=1` (skip the build probe), `SKIP_SERVICES=1` (skip
Ollama/whisper). A clean run prints `M0 native + service checks passed.`

## 4. Install and run the services

```bash
infra/install.sh
```

Idempotent — safe to re-run after every `git pull`. It runs `pnpm install`,
`pnpm build`, ensures `STORAGE_DIR` exists, then renders
`infra/systemd/*.service.in` with this host's user, absolute repo path, and
absolute `node` binary, installs them into `/etc/systemd/system`, reloads
systemd, and **enables** both services so they start on boot (NFR-2). It starts
each service whose built entry point (`packages/<svc>/dist/index.js`) already
exists and whose `.env` is present; otherwise it enables-only and tells you what
is missing.

Run it **as the operator** (not root) so the services run as that user and can
reach the GPU + storage. The systemd write steps auto-escalate with `sudo`.

**Native build scripts:** pnpm gates package build scripts by default, so a first
`pnpm install` on a fresh host stops with `ERR_PNPM_IGNORED_BUILDS` because the
capture service's native modules (`@discordjs/opus`, `sodium-native`) need to
compile on ARM64 (D-1/D-2). `install.sh` detects this, builds those modules, and
retries automatically — no interactive `pnpm approve-builds` needed. If the
compile itself fails, install a C toolchain first:
`sudo apt-get install -y build-essential python3 cmake`.

Flags: `--no-services` (build only), `--user USER` (run services as USER).

Services installed:

| Unit | Package | Role |
|---|---|---|
| `discord-agent-capture.service` | `packages/capture` | presence, DM/channel text, voice-state auto-join, per-speaker DAVE capture |
| `discord-agent-processing.service` | `packages/processing` | faster-whisper STT → merge → dual JSON summary → post/email |

Operate them:

```bash
systemctl status discord-agent-capture discord-agent-processing
journalctl -u discord-agent-capture -f          # follow logs
sudo systemctl restart discord-agent-capture     # after a rebuild
sudo systemctl stop discord-agent-processing
```

The units restart on failure (`Restart=on-failure`, 5s backoff, capped at 5
restarts/60s to avoid crash loops). Capture is stopped with `SIGINT` and a 30s
grace window so an in-progress recording can flush its tracks + manifest (NFR-3).

**GPU access:** faster-whisper needs the NVIDIA devices. If the operator user
cannot see the GPU, add it to the right group (`sudo usermod -aG video,render
$USER`) and re-log, or confirm `nvidia-smi` works as that user. The units use
moderate hardening (`ProtectSystem=full`, `NoNewPrivileges`, `PrivateTmp`) that
leaves `/home`, `/dev`, and the GPU reachable.

**Editing the units:** change the `.service.in` templates (not the rendered files
in `/etc/systemd/system`) and re-run `infra/install.sh`, or edit the rendered unit
and `sudo systemctl daemon-reload`.

## 5. Retention

Per `DECISIONS.md` Q5: audio is the large, most-sensitive artifact; text is small
and useful.

- `AUDIO_RETENTION_DAYS` (default `7`) — raw per-speaker audio is auto-purged
  after this many days by the processing service.
- `VIDEO_RETENTION_DAYS` (default = `AUDIO_RETENTION_DAYS`) — `video.mp4` is
  auto-purged after this many days by the same sweep. Video is large and
  sensitive, so keep it at or below the audio window. The timecoded transcript
  (`transcript.timecoded.md`) is a text artifact and is kept indefinitely.
- Transcripts and summaries are retained indefinitely under `STORAGE_DIR`
  (default `./data/calls`, one directory per call). Delete manually when desired.
- Nothing is uploaded to the cloud; all call data stays on the Spark.

## 6. Arming a channel

Auto-record is **opt-in per channel** (DECISIONS Q4), so the agent never joins an
unarmed channel.

- Pre-arm at boot: list voice channel IDs in `DISCORD_AUTORECORD_CHANNEL_IDS`.
- Arm/disarm live: use the `/arm` and `/disarm` slash commands in the guild
  (operator-run; provided by the capture service).
- Default trigger: the agent joins an armed channel when **>= 1 non-bot human** is
  present. Narrow this with `DISCORD_TRIGGER_ROLE_IDS` / `DISCORD_TRIGGER_USER_IDS`
  to only join when a specific role/user is in the channel.

On joining, the agent **announces in the channel's text chat that recording has
started** (FR-10) and stops/leaves when the channel empties (FR-13).

## 7. Consent & recording disclosure

Recording participants' audio must be known to everyone in the call (PRD §3, D-7,
NFR-6). This deployment is for a **small, known, private group of consenting
members**. Requirements:

- Keep recording **opt-in per channel** — do not arm channels whose members have
  not agreed to be recorded.
- The recording-start announcement (FR-10) must remain enabled so recording state
  is always visible while a call is active. When video is enabled (§9) the
  announcement automatically states that **audio and video** are being recorded;
  every participant must know video capture is active before joining.
- The agent carries a non-removable Discord **APP/BOT badge** — members can always
  see it is an automated participant (self-botting to hide this is out of scope
  and against Discord ToS).

## 8. Privacy boundary — what is and isn't private

Per PRD §3 / D-8. **Read this before putting anything sensitive in text.**

- **Local (private):** all model inference (Ollama summaries, faster-whisper
  transcription) and all stored audio/transcripts/summaries stay on the Spark. No
  third-party AI APIs are ever called (NFR-1).
- **Voice in transit:** end-to-end encrypted by Discord's DAVE protocol; the agent
  is an authorized endpoint that decrypts only its own incoming streams.
- **Discord text is NOT end-to-end encrypted.** Channel messages, DMs, and the
  posted summaries pass through Discord's servers in plaintext. **Email** transport
  (IMAP/SMTP) also leaves the box by nature. Keep sensitive content out of text
  and email; the privacy guarantee is "inference + storage local," not "text
  private."

## 9. Video recording (optional)

Off by default. This is the ToS-compliant "Path A" from `docs/SPEC-video-recording.v0.1.0.md`:
Discord never delivers camera/screen-share video to a bot, so video comes from a
real client's rendered output via **OBS**. The bot only (a) tells OBS to
start/stop over OBS WebSocket, and (b) optionally **moves** an already-connected
recorder account between voice channels. It never automates a user account's
voice *connection* (that is self-botting). With `OBS_ENABLED=false` behavior is
byte-for-byte identical to audio-only, and any OBS/recorder failure degrades that
call to audio-only — it never blocks the summary or delivery.

**Deployment topology (this workstation).** OBS runs on **this workstation**,
co-located with the capture service and the recorder/`context-backdrop` client;
model inference (Ollama + faster-whisper) stays on the Spark over Tailscale. So the
OBS WebSocket and output dir are **local** — no mount or cross-host copy.

**Shared OBS with `context-backdrop`.** The same OBS instance runs the
`context-backdrop` pipeline (operator video + HUD cards → virtual camera → Discord;
see `~/Downloads/context-backdrop-prd-v0.3.0.md`). This bot **only toggles recording**
(`StartRecord`/`StopRecord`) — it never touches scenes, sources, or the virtual
camera, which context-backdrop owns. The two coexist on one OBS.

**What OBS records — record the incoming call grid (recommended).** context-backdrop's
*program / virtual-camera* output is the operator+HUD composite (the outgoing feed). The
useful meeting video is the **incoming call grid**, so add a **dedicated OBS scene**
that window-captures the Discord client (everyone's tiles) and select it as OBS's
**recording** scene while the virtual camera keeps sending context-backdrop's composite.
Net: virtual cam = operator+HUD (unchanged), file recording = the meeting grid (aligned
to the transcript). To record the composite instead, just point recording at that scene
— the bot is scene-agnostic and grabs whatever file OBS writes.

**Setup steps:**

1. **Enable OBS WebSocket** (OBS → Tools → WebSocket Server Settings → enable; default
   port `4455`; set a password). Set `OBS_ENABLED=true`,
   `OBS_WEBSOCKET_URL=ws://127.0.0.1:4455`, and `OBS_WEBSOCKET_PASSWORD` to match.
2. **Add the grid-capture scene** (above) and select it as OBS's recording scene.
3. **Set the output dir.** `OBS_OUTPUT_DIR=/home/bob/Videos/discord-agent` (a local
   folder OBS records into); the capture service copies the finished file into the call
   dir as `video.mp4`. Leave empty to reference OBS's own path instead of copying.
4. **Recorder-account move — likely unused here.** In the context-backdrop deployment
   the recording account is *already in the call* (running its virtual camera), so leave
   `RECORDER_USER_ID` **unset** and the automatic move is skipped. Set it (plus
   `RECORDER_LOBBY_CHANNEL_ID` and the bot's `Move Members` permission) only if you
   instead park a separate recorder account in a lobby for the bot to pull in — that
   account must already be running a client and be voice-connected.

**Consent (hard requirement):** when video is enabled the recording-start
announcement automatically states that **audio and video** are being recorded
(§7). Do not enable video on channels whose members have not agreed to video
capture.

**Retention:** `video.mp4` is purged after `VIDEO_RETENTION_DAYS` (see §5); the
timecoded transcript is kept.

**Rollback:** set `OBS_ENABLED=false` (or unset the block) and restart capture —
the system reverts to audio-only with no other change.
