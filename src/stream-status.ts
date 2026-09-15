/**
 * Original `relay/common.StreamStatus` / `relay/helper.StreamScannerHandler`
 * end-reason tracking for consume-log `stream_status`. Must not import store /
 * relay / convert / query / submit.
 */

export const STREAM_END_REASON_NONE = "";
export const STREAM_END_REASON_DONE = "done";
export const STREAM_END_REASON_TIMEOUT = "timeout";
export const STREAM_END_REASON_CLIENT_GONE = "client_gone";
export const STREAM_END_REASON_SCANNER_ERR = "scanner_error";
export const STREAM_END_REASON_HANDLER_STOP = "handler_stop";
export const STREAM_END_REASON_EOF = "eof";
export const STREAM_END_REASON_PANIC = "panic";
export const STREAM_END_REASON_PING_FAIL = "ping_fail";

export type StreamEndReason =
  | typeof STREAM_END_REASON_NONE
  | typeof STREAM_END_REASON_DONE
  | typeof STREAM_END_REASON_TIMEOUT
  | typeof STREAM_END_REASON_CLIENT_GONE
  | typeof STREAM_END_REASON_SCANNER_ERR
  | typeof STREAM_END_REASON_HANDLER_STOP
  | typeof STREAM_END_REASON_EOF
  | typeof STREAM_END_REASON_PANIC
  | typeof STREAM_END_REASON_PING_FAIL
  | string;

const MAX_STREAM_ERROR_ENTRIES = 20;

export type StreamErrorEntry = {
  message: string;
  timestamp: number;
};

/** Original `relay/common.NewStreamStatus`. */
export class StreamStatus {
  endReason: StreamEndReason = STREAM_END_REASON_NONE;
  endError: Error | null = null;
  errors: StreamErrorEntry[] = [];
  errorCount = 0;
  private ended = false;

  /** Original `(*StreamStatus).SetEndReason` — first write wins. */
  setEndReason(reason: StreamEndReason, err: Error | null = null): void {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    this.endError = err;
  }

  /** Original `(*StreamStatus).RecordError` — ErrorCount uncapped, Errors capped at 20. */
  recordError(msg: string): void {
    this.errorCount++;
    if (this.errors.length < MAX_STREAM_ERROR_ENTRIES) {
      this.errors.push({ message: msg, timestamp: Date.now() });
    }
  }

  hasErrors(): boolean {
    return this.errorCount > 0;
  }

  totalErrorCount(): number {
    return this.errorCount;
  }

  /** Original `(*StreamStatus).IsNormalEnd` — done, eof, handler_stop. */
  isNormalEnd(): boolean {
    return (
      this.endReason === STREAM_END_REASON_DONE ||
      this.endReason === STREAM_END_REASON_EOF ||
      this.endReason === STREAM_END_REASON_HANDLER_STOP
    );
  }

  /** Original `(*StreamStatus).Summary`. */
  summary(): string {
    let out = `reason=${this.endReason}`;
    if (this.endError) out += ` end_error=${JSON.stringify(this.endError.message)}`;
    if (this.errorCount > 0) out += ` soft_errors=${this.errorCount}`;
    return out;
  }
}

/** Original nil-receiver `SetEndReason`. */
export function setStreamEndReason(
  status: StreamStatus | null | undefined,
  reason: StreamEndReason,
  err: Error | null = null,
): void {
  status?.setEndReason(reason, err);
}

/** Original nil-receiver `RecordError`. */
export function recordStreamError(status: StreamStatus | null | undefined, msg: string): void {
  status?.recordError(msg);
}

/** Original nil-receiver `HasErrors`. */
export function streamHasErrors(status: StreamStatus | null | undefined): boolean {
  return status ? status.hasErrors() : false;
}

/** Original nil-receiver `TotalErrorCount`. */
export function streamTotalErrorCount(status: StreamStatus | null | undefined): number {
  return status ? status.totalErrorCount() : 0;
}

/** Original nil-receiver `IsNormalEnd` — nil is a normal end. */
export function streamIsNormalEnd(status: StreamStatus | null | undefined): boolean {
  return status ? status.isNormalEnd() : true;
}

/** Original nil-receiver `Summary`. */
export function streamSummary(status: StreamStatus | null | undefined): string {
  return status ? status.summary() : "StreamStatus<nil>";
}

export function ensureStreamStatus(holder: { streamStatus?: StreamStatus }): StreamStatus {
  if (!holder.streamStatus) holder.streamStatus = new StreamStatus();
  return holder.streamStatus;
}

/**
 * Original StreamScannerHandler end-reason from an already-buffered SSE body:
 * `data:` payload prefix `[DONE]` → done (first-wins); otherwise eof.
 */
export function applySseScannerEndReason(status: StreamStatus | null | undefined, text: string): void {
  if (!status) return;
  const lines = String(text || "").split(/\r?\n/);
  for (const data of lines) {
    if (data.length < 6) continue;
    if (!data.startsWith("data:") && data.slice(0, 6) !== "[DONE]") continue;
    const payload = data.slice(5).trim();
    if (!payload) continue;
    if (payload.startsWith("[DONE]")) {
      status.setEndReason(STREAM_END_REASON_DONE);
      return;
    }
  }
  status.setEndReason(STREAM_END_REASON_EOF);
}

export function noteSseStreamStatus(holder: { streamStatus?: StreamStatus }, text: string): StreamStatus {
  const status = ensureStreamStatus(holder);
  applySseScannerEndReason(status, text);
  return status;
}
