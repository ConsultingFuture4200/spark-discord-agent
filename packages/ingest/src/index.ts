/**
 * @discord-agent/ingest — gBrain ingest emitter + /ask recall.
 *
 * Discord-library-free by design: capture adapts discord.js objects into the
 * plain {@link MessageEvent}/{@link MessageDeleteEvent} shapes, processing
 * passes its shared-contract call outputs straight through, and everything
 * here is fixture-testable against a stub gBrain HTTP server.
 */
export * from "./events.js";
export * from "./consent.js";
export * from "./client.js";
export { EventOutbox, type OutboxOptions } from "./outbox.js";
export { IngestEmitter, messageSourceRef, type IngestEmitterDeps } from "./emitter.js";
export * from "./ask.js";
