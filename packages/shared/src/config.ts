import { z } from "zod";

/**
 * Config schema + loader.
 *
 * The zod schema parses a raw environment record (typically `process.env`)
 * into a typed, validated Config. Keep this the single source of truth for
 * what every service expects from the environment.
 */

/** Coerce a "true"/"false"/"1"/"0" string into a boolean. */
const envBool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return defaultValue;
      return v === "true" || v === "1" || v.toLowerCase() === "yes";
    });

/** Split a comma-separated env string into a trimmed, non-empty string array. */
const envList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

/** Coerce a numeric env string, applying a default when absent/empty. */
const envInt = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? defaultValue : v))
    .pipe(z.coerce.number().int());

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * The raw env shape. Field names map 1:1 to keys in `.env.example`.
 * `loadConfig` reshapes this into the nested {@link Config} object below.
 */
const RawEnvSchema = z.object({
  // Discord
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_APP_ID: z.string().min(1, "DISCORD_APP_ID is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  DISCORD_AUTORECORD_CHANNEL_IDS: envList,
  DISCORD_TRIGGER_ROLE_IDS: envList,
  DISCORD_TRIGGER_USER_IDS: envList,

  // Ollama
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434/v1"),
  OLLAMA_INTERACTIVE_MODEL: z.string().min(1).default("qwen2.5:7b"),
  OLLAMA_BATCH_MODEL: z.string().min(1).default("qwen2.5:32b"),
  OLLAMA_API_KEY: z.string().optional(),

  // Whisper
  WHISPER_MODEL: z.string().min(1).default("large-v3"),
  WHISPER_COMPUTE_TYPE: z.string().min(1).default("float16"),

  // Email (IMAP read / SMTP send). Optional as a block — validated when present.
  IMAP_HOST: z.string().optional(),
  IMAP_PORT: envInt(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  IMAP_TLS: envBool(true),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: envInt(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: envBool(true),
  AGENT_EMAIL_FROM: z.string().email().optional(),

  // Storage & retention
  STORAGE_DIR: z.string().min(1).default("./data/calls"),
  AUDIO_RETENTION_DAYS: envInt(7),
  // Video retention defaults to AUDIO_RETENTION_DAYS when unset (resolved in loadConfig).
  VIDEO_RETENTION_DAYS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v))
    .pipe(z.coerce.number().int().optional()),

  // OBS video recording (optional block, gated by OBS_ENABLED). Validated when enabled.
  OBS_ENABLED: envBool(false),
  OBS_WEBSOCKET_URL: z.string().optional(),
  OBS_WEBSOCKET_PASSWORD: z.string().optional(),
  OBS_OUTPUT_DIR: z.string().optional(),
  RECORDER_USER_ID: z.string().optional(),
  RECORDER_LOBBY_CHANNEL_ID: z.string().optional(),

  // gBrain ingest (optional block, gated by INGEST_ENABLED). All fields default.
  INGEST_ENABLED: envBool(false),
  GBRAIN_BASE_URL: z.string().url().default("http://127.0.0.1:8770"),
  INGEST_CONSENT_PATH: z.string().min(1).default("./data/ingest/consent.json"),
  INGEST_STATE_DIR: z.string().min(1).default("./data/ingest"),
  INGEST_REGION: z.string().min(1).default("discord"),

  // Runtime
  LOG_LEVEL: LogLevelSchema.default("info"),
});

export const DiscordConfigSchema = z.object({
  token: z.string(),
  appId: z.string(),
  guildId: z.string(),
  autoRecordChannelIds: z.array(z.string()),
  triggerRoleIds: z.array(z.string()),
  triggerUserIds: z.array(z.string()),
});

export const OllamaConfigSchema = z.object({
  baseUrl: z.string().url(),
  interactiveModel: z.string(),
  batchModel: z.string(),
  apiKey: z.string().optional(),
});

export const WhisperConfigSchema = z.object({
  model: z.string(),
  computeType: z.string(),
});

export const ImapConfigSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  user: z.string(),
  password: z.string(),
  tls: z.boolean(),
});

export const SmtpConfigSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  user: z.string(),
  password: z.string(),
  secure: z.boolean(),
  from: z.string().email(),
});

export const EmailConfigSchema = z.object({
  imap: ImapConfigSchema,
  smtp: SmtpConfigSchema,
});

/**
 * OBS video-recording block. Present only when `OBS_ENABLED=true`; otherwise
 * `config.obs` is undefined and no OBS/recorder code runs. `websocketUrl` is the
 * one required field when enabled; the rest are optional.
 */
export const ObsConfigSchema = z.object({
  websocketUrl: z.string().url(),
  websocketPassword: z.string().optional(),
  outputDir: z.string().optional(),
  recorderUserId: z.string().optional(),
  recorderLobbyChannelId: z.string().optional(),
});

/**
 * gBrain ingest block (community-memory emitters + /ask). Present only when
 * `INGEST_ENABLED=true`; otherwise `config.ingest` is undefined and no ingest
 * code runs. Every field has a safe default, and consent still gates what is
 * actually emitted (a missing consent file at `consentPath` denies everything).
 */
export const IngestConfigSchema = z.object({
  /** gBrain v2 base URL (e.g. over Tailscale to the Spark). */
  gbrainBaseUrl: z.string().url(),
  /** Path to the consent JSON (channel allowlist + member opt-out). */
  consentPath: z.string(),
  /** Directory for ingest state (the source-URI → memory-id map). */
  stateDir: z.string(),
  /** gBrain region column value for every ingested node. */
  region: z.string(),
});

export const StorageConfigSchema = z.object({
  dir: z.string(),
  audioRetentionDays: z.number().int().nonnegative(),
  videoRetentionDays: z.number().int().nonnegative(),
});

export const ConfigSchema = z.object({
  discord: DiscordConfigSchema,
  ollama: OllamaConfigSchema,
  whisper: WhisperConfigSchema,
  /** Present only when a full IMAP+SMTP set is configured; otherwise undefined. */
  email: EmailConfigSchema.optional(),
  /** Present only when `OBS_ENABLED=true`; otherwise undefined (feature off). */
  obs: ObsConfigSchema.optional(),
  /** Present only when `INGEST_ENABLED=true`; otherwise undefined (feature off). */
  ingest: IngestConfigSchema.optional(),
  storage: StorageConfigSchema,
  logLevel: LogLevelSchema,
});

export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
export type WhisperConfig = z.infer<typeof WhisperConfigSchema>;
export type ImapConfig = z.infer<typeof ImapConfigSchema>;
export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type ObsConfig = z.infer<typeof ObsConfigSchema>;
export type IngestConfig = z.infer<typeof IngestConfigSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Parse and validate a raw environment record into a typed {@link Config}.
 *
 * Pure: takes the env in as an argument (defaults to `process.env`) so it is
 * fully testable without mutating global state. Throws {@link ConfigError} with
 * an aggregated, human-readable message when validation fails.
 *
 * Email is treated as an optional block: if none of the IMAP/SMTP fields are
 * set, `config.email` is `undefined` (agent runs without email). If the block
 * is partially set, that is a hard error — half-configured email is a bug.
 *
 * OBS is gated by `OBS_ENABLED`: false (default) → `config.obs` is `undefined`
 * (feature off, behavior identical to audio-only); true but missing the required
 * `OBS_WEBSOCKET_URL` is a hard error.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error));
  }
  const e = parsed.data;

  const email = buildEmailConfig(e);
  const obs = buildObsConfig(e);
  const ingest = buildIngestConfig(e);

  const config: Config = {
    discord: {
      token: e.DISCORD_TOKEN,
      appId: e.DISCORD_APP_ID,
      guildId: e.DISCORD_GUILD_ID,
      autoRecordChannelIds: e.DISCORD_AUTORECORD_CHANNEL_IDS,
      triggerRoleIds: e.DISCORD_TRIGGER_ROLE_IDS,
      triggerUserIds: e.DISCORD_TRIGGER_USER_IDS,
    },
    ollama: {
      baseUrl: e.OLLAMA_BASE_URL,
      interactiveModel: e.OLLAMA_INTERACTIVE_MODEL,
      batchModel: e.OLLAMA_BATCH_MODEL,
      ...(e.OLLAMA_API_KEY ? { apiKey: e.OLLAMA_API_KEY } : {}),
    },
    whisper: {
      model: e.WHISPER_MODEL,
      computeType: e.WHISPER_COMPUTE_TYPE,
    },
    ...(email ? { email } : {}),
    ...(obs ? { obs } : {}),
    ...(ingest ? { ingest } : {}),
    storage: {
      dir: e.STORAGE_DIR,
      audioRetentionDays: e.AUDIO_RETENTION_DAYS,
      videoRetentionDays: e.VIDEO_RETENTION_DAYS ?? e.AUDIO_RETENTION_DAYS,
    },
    logLevel: e.LOG_LEVEL,
  };

  return ConfigSchema.parse(config);
}

/** Build the email block, or return undefined if fully unconfigured. Throws on partial config. */
function buildEmailConfig(e: z.infer<typeof RawEnvSchema>): EmailConfig | undefined {
  const emailFields = [
    e.IMAP_HOST,
    e.IMAP_USER,
    e.IMAP_PASSWORD,
    e.SMTP_HOST,
    e.SMTP_USER,
    e.SMTP_PASSWORD,
    e.AGENT_EMAIL_FROM,
  ];
  const anySet = emailFields.some((v) => v !== undefined && v !== "");
  if (!anySet) return undefined;

  const candidate = {
    imap: {
      host: e.IMAP_HOST,
      port: e.IMAP_PORT,
      user: e.IMAP_USER,
      password: e.IMAP_PASSWORD,
      tls: e.IMAP_TLS,
    },
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      password: e.SMTP_PASSWORD,
      secure: e.SMTP_SECURE,
      from: e.AGENT_EMAIL_FROM,
    },
  };

  const result = EmailConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError(
      "Email is partially configured. Set all of IMAP_HOST/IMAP_USER/IMAP_PASSWORD, " +
        "SMTP_HOST/SMTP_USER/SMTP_PASSWORD, and AGENT_EMAIL_FROM, or leave them all unset.\n" +
        formatZodError(result.error),
    );
  }
  return result.data;
}

/**
 * Build the OBS block when `OBS_ENABLED=true`, or return undefined when the gate
 * is off. Throws when enabled but the required `OBS_WEBSOCKET_URL` is missing or
 * invalid — a half-configured recorder is a bug, not a silent audio-only run.
 */
function buildObsConfig(e: z.infer<typeof RawEnvSchema>): ObsConfig | undefined {
  if (!e.OBS_ENABLED) return undefined;

  const candidate = {
    websocketUrl: e.OBS_WEBSOCKET_URL,
    websocketPassword: e.OBS_WEBSOCKET_PASSWORD,
    outputDir: e.OBS_OUTPUT_DIR,
    recorderUserId: e.RECORDER_USER_ID,
    recorderLobbyChannelId: e.RECORDER_LOBBY_CHANNEL_ID,
  };

  const result = ObsConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError(
      "OBS is enabled (OBS_ENABLED=true) but misconfigured. Set OBS_WEBSOCKET_URL " +
        "to the OBS WebSocket v5 URL (e.g. ws://recorder-host:4455), or set " +
        "OBS_ENABLED=false to disable video recording.\n" +
        formatZodError(result.error),
    );
  }
  return result.data;
}

/**
 * Build the ingest block when `INGEST_ENABLED=true`, or return undefined when
 * the gate is off. Every field has a schema default, so an enabled block never
 * fails here; consent enforcement happens at emit time in the ingest package.
 */
function buildIngestConfig(e: z.infer<typeof RawEnvSchema>): IngestConfig | undefined {
  if (!e.INGEST_ENABLED) return undefined;
  return {
    gbrainBaseUrl: e.GBRAIN_BASE_URL,
    consentPath: e.INGEST_CONSENT_PATH,
    stateDir: e.INGEST_STATE_DIR,
    region: e.INGEST_REGION,
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.join(".");
      return path ? `  - ${path}: ${i.message}` : `  - ${i.message}`;
    })
    .join("\n");
}
