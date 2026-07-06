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
});
