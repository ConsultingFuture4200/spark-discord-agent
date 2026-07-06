import { ImapSmtpEmailGateway } from "@discord-agent/agent-tools";
import type { EmailConfig } from "@discord-agent/shared";
import type { Emailer } from "./ports.js";

/**
 * Concrete {@link Emailer} backed by `@discord-agent/agent-tools`' SMTP gateway.
 *
 * The processing-side half of the processing ↔ agent-tools email seam: it wraps
 * the reusable {@link ImapSmtpEmailGateway} and pins the delivery recipient
 * (the summary always goes to one address — the owner's inbox), exposing only
 * the narrow `sendSummary` the pipeline depends on.
 */
export function createEmailer(config: EmailConfig, to: string): Emailer {
  const gateway = new ImapSmtpEmailGateway(config);
  return {
    async sendSummary(input: { subject: string; markdown: string }): Promise<void> {
      await gateway.send({ to, subject: input.subject, text: input.markdown });
    },
  };
}
