import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

/** A minimal env with only the required Discord fields set. */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "token-123",
    DISCORD_APP_ID: "app-123",
    DISCORD_GUILD_ID: "guild-123",
  };
}

describe("loadConfig", () => {
  it("loads defaults when only required Discord fields are set", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.discord.token).toBe("token-123");
    expect(cfg.discord.autoRecordChannelIds).toEqual([]);
    expect(cfg.ollama.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(cfg.ollama.interactiveModel).toBe("qwen2.5:7b");
    expect(cfg.ollama.batchModel).toBe("qwen2.5:32b");
    expect(cfg.whisper.model).toBe("large-v3");
    expect(cfg.storage.dir).toBe("./data/calls");
    expect(cfg.storage.audioRetentionDays).toBe(7);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.email).toBeUndefined();
  });

  it("throws ConfigError when a required field is missing", () => {
    const env = baseEnv();
    delete env.DISCORD_TOKEN;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("parses comma-separated channel and trigger id lists", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      DISCORD_AUTORECORD_CHANNEL_IDS: "111, 222 ,333",
      DISCORD_TRIGGER_ROLE_IDS: "role-a",
      DISCORD_TRIGGER_USER_IDS: "",
    });
    expect(cfg.discord.autoRecordChannelIds).toEqual(["111", "222", "333"]);
    expect(cfg.discord.triggerRoleIds).toEqual(["role-a"]);
    expect(cfg.discord.triggerUserIds).toEqual([]);
  });

  it("coerces numeric and boolean env strings", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      AUDIO_RETENTION_DAYS: "14",
      IMAP_HOST: "imap.example.com",
      IMAP_PORT: "1993",
      IMAP_USER: "agent@example.com",
      IMAP_PASSWORD: "pw",
      IMAP_TLS: "false",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "2465",
      SMTP_USER: "agent@example.com",
      SMTP_PASSWORD: "pw",
      SMTP_SECURE: "1",
      AGENT_EMAIL_FROM: "agent@example.com",
    });
    expect(cfg.storage.audioRetentionDays).toBe(14);
    expect(cfg.email?.imap.port).toBe(1993);
    expect(cfg.email?.imap.tls).toBe(false);
    expect(cfg.email?.smtp.port).toBe(2465);
    expect(cfg.email?.smtp.secure).toBe(true);
    expect(cfg.email?.smtp.from).toBe("agent@example.com");
  });

  it("throws when email is only partially configured", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), IMAP_HOST: "imap.example.com" }),
    ).toThrow(ConfigError);
  });

  it("rejects an invalid Ollama base URL", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), OLLAMA_BASE_URL: "not-a-url" }),
    ).toThrow();
  });

  it("omits apiKey when OLLAMA_API_KEY is unset", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.ollama.apiKey).toBeUndefined();
  });

  it("defaults videoRetentionDays to audioRetentionDays when unset", () => {
    const cfg = loadConfig({ ...baseEnv(), AUDIO_RETENTION_DAYS: "10" });
    expect(cfg.storage.audioRetentionDays).toBe(10);
    expect(cfg.storage.videoRetentionDays).toBe(10);
  });

  it("uses an explicit VIDEO_RETENTION_DAYS over the audio default", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      AUDIO_RETENTION_DAYS: "7",
      VIDEO_RETENTION_DAYS: "3",
    });
    expect(cfg.storage.videoRetentionDays).toBe(3);
  });

  it("leaves config.obs undefined when OBS_ENABLED is unset (feature off)", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.obs).toBeUndefined();
  });

  it("leaves config.obs undefined when OBS_ENABLED is false, ignoring stray OBS fields", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      OBS_ENABLED: "false",
      OBS_WEBSOCKET_URL: "ws://recorder-host:4455",
    });
    expect(cfg.obs).toBeUndefined();
  });

  it("builds the full obs block when enabled with all fields", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      OBS_ENABLED: "true",
      OBS_WEBSOCKET_URL: "ws://recorder-host:4455",
      OBS_WEBSOCKET_PASSWORD: "secret",
      OBS_OUTPUT_DIR: "/mnt/obs",
      RECORDER_USER_ID: "user-42",
      RECORDER_LOBBY_CHANNEL_ID: "chan-9",
    });
    expect(cfg.obs).toEqual({
      websocketUrl: "ws://recorder-host:4455",
      websocketPassword: "secret",
      outputDir: "/mnt/obs",
      recorderUserId: "user-42",
      recorderLobbyChannelId: "chan-9",
    });
  });

  it("builds a minimal obs block when enabled with only the required URL", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      OBS_ENABLED: "true",
      OBS_WEBSOCKET_URL: "ws://recorder-host:4455",
    });
    expect(cfg.obs?.websocketUrl).toBe("ws://recorder-host:4455");
    expect(cfg.obs?.websocketPassword).toBeUndefined();
    expect(cfg.obs?.recorderUserId).toBeUndefined();
  });

  it("throws when OBS is enabled but OBS_WEBSOCKET_URL is missing", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), OBS_ENABLED: "true" }),
    ).toThrow(ConfigError);
  });

  it("throws when OBS is enabled but OBS_WEBSOCKET_URL is not a valid URL", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        OBS_ENABLED: "true",
        OBS_WEBSOCKET_URL: "not-a-url",
      }),
    ).toThrow(ConfigError);
  });
});
