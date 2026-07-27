/**
 * Structured NDJSON emitter (protocol v2).
 *
 * Single exit point for all business output of the bridge. Replaces the legacy
 * "[TAG] <json>" text-line protocol: every message is written as one JSON
 * envelope per line instead of a tagged string that Java had to prefix-match
 * and re-parse.
 *
 * Envelope shapes on stdout:
 *   Daemon mode:      {"id":"<activeRequestId>","type":"content_delta","data":"..."}
 *   Per-process mode: {"type":"content_delta","data":"..."}
 *   Completion:       {"id":"<activeRequestId>","done":true,"success":true}
 *   Daemon log/event: {"type":"daemon","event":"log","message":"..."}
 *
 * The emitter itself knows nothing about request IDs or transport details:
 * the writer injected via initEmitter() owns serialization and (in daemon
 * mode) tagging with the current activeRequestId. Until initEmitter() is
 * called every emit* function is a safe no-op, so modules can be imported
 * and unit-tested without a transport.
 */

let dataWriter = null;
let logWriter = null;

/**
 * Inject the transport at process startup (daemon.js / channel-manager.js).
 *
 * @param {(obj: object) => void} writer - Serializes one envelope object as a
 *   single NDJSON line to the real stdout. In daemon mode the writer closure
 *   captures a "get current request id" function and adds `id` itself.
 * @param {(text: string) => void} [logSink] - Optional sink for diagnostic
 *   logs. Per-process mode passes a stderr writer so logs stay out of the
 *   stdout data stream. When omitted, emitLog() falls back to a
 *   {type:'daemon', event:'log'} envelope through the data writer.
 */
export function initEmitter(writer, logSink = null) {
  dataWriter = typeof writer === 'function' ? writer : null;
  logWriter = typeof logSink === 'function' ? logSink : null;
}

function writeEnvelope(obj) {
  if (!dataWriter) return;
  try {
    dataWriter(obj);
  } catch {
    // Output must never crash business logic (e.g. EPIPE on a dead parent).
  }
}

/**
 * Emit a typed business event: {type, data} (+ id in daemon mode).
 * `data` may be a string, object, or omitted (marker events like stream_start).
 */
export function emit(type, data) {
  if (data === undefined) {
    writeEnvelope({ type });
  } else {
    writeEnvelope({ type, data });
  }
}

/**
 * Emit a diagnostic log line. Logs are NOT part of the data protocol:
 * per-process they go to stderr; in daemon mode they become
 * {type:'daemon', event:'log'} envelopes which Java routes to its log file.
 */
export function emitLog(message) {
  const text = String(message);
  if (logWriter) {
    try {
      logWriter(text);
    } catch {
      // Same no-crash guarantee as writeEnvelope.
    }
    return;
  }
  writeEnvelope({ type: 'daemon', event: 'log', message: text });
}

/**
 * Emit a daemon lifecycle / out-of-band event: {type:'daemon', event, ...data}.
 * Never carries a request id, so it is safe to use between turns (e.g. the
 * inter-turn 'session_updated' event from the perpetual reader).
 */
export function emitDaemonEvent(event, data = {}) {
  writeEnvelope({ type: 'daemon', event, ...data });
}

/**
 * Emit the request completion signal: {done:true, success, error?}
 * (+ id in daemon mode via the writer).
 */
export function emitDone(success, error = undefined) {
  const envelope = { done: true, success: !!success };
  if (error !== undefined && error !== null) {
    envelope.error = String(error);
  }
  writeEnvelope(envelope);
}
