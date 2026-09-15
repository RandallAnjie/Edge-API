import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySseScannerEndReason,
  recordStreamError,
  setStreamEndReason,
  STREAM_END_REASON_CLIENT_GONE,
  STREAM_END_REASON_DONE,
  STREAM_END_REASON_EOF,
  STREAM_END_REASON_HANDLER_STOP,
  STREAM_END_REASON_NONE,
  STREAM_END_REASON_PANIC,
  STREAM_END_REASON_PING_FAIL,
  STREAM_END_REASON_SCANNER_ERR,
  STREAM_END_REASON_TIMEOUT,
  streamHasErrors,
  streamIsNormalEnd,
  StreamStatus,
  streamSummary,
  streamTotalErrorCount,
} from "../src/stream-status.js";

test("original StreamStatus SetEndReason first-wins", () => {
  const s = new StreamStatus();
  s.setEndReason(STREAM_END_REASON_DONE);
  s.setEndReason(STREAM_END_REASON_TIMEOUT);
  s.setEndReason(STREAM_END_REASON_CLIENT_GONE, new Error("context canceled"));
  assert.equal(s.endReason, STREAM_END_REASON_DONE);
  assert.equal(s.endError, null);
});

test("original StreamStatus SetEndReason with error", () => {
  const s = new StreamStatus();
  const expected = new Error("read: connection reset");
  s.setEndReason(STREAM_END_REASON_SCANNER_ERR, expected);
  assert.equal(s.endReason, STREAM_END_REASON_SCANNER_ERR);
  assert.equal(s.endError, expected);
});

test("original StreamStatus nil-safe SetEndReason / RecordError / HasErrors", () => {
  const s: StreamStatus | null = null;
  setStreamEndReason(s, STREAM_END_REASON_DONE);
  recordStreamError(s, "should not panic");
  assert.equal(streamHasErrors(s), false);
  assert.equal(streamTotalErrorCount(s), 0);
  assert.equal(streamIsNormalEnd(s), true);
  assert.equal(streamSummary(s), "StreamStatus<nil>");
});

test("original StreamStatus RecordError cap 20 with ErrorCount 30", () => {
  const s = new StreamStatus();
  for (let i = 0; i < 30; i++) s.recordError(`error_${i}`);
  assert.equal(s.errors.length, 20);
  assert.equal(s.totalErrorCount(), 30);
  assert.equal(s.hasErrors(), true);
});

test("original StreamStatus IsNormalEnd", () => {
  const cases: Array<[string, boolean]> = [
    [STREAM_END_REASON_DONE, true],
    [STREAM_END_REASON_EOF, true],
    [STREAM_END_REASON_HANDLER_STOP, true],
    [STREAM_END_REASON_TIMEOUT, false],
    [STREAM_END_REASON_CLIENT_GONE, false],
    [STREAM_END_REASON_SCANNER_ERR, false],
    [STREAM_END_REASON_PANIC, false],
    [STREAM_END_REASON_PING_FAIL, false],
    [STREAM_END_REASON_NONE, false],
  ];
  for (const [reason, normal] of cases) {
    const s = new StreamStatus();
    s.setEndReason(reason);
    assert.equal(s.isNormalEnd(), normal, `reason=${reason}`);
  }
});

test("original StreamStatus Summary", () => {
  const s = new StreamStatus();
  s.setEndReason(STREAM_END_REASON_DONE);
  assert.match(s.summary(), /reason=done/);
  assert.equal(s.summary().includes("soft_errors"), false);

  const s2 = new StreamStatus();
  s2.setEndReason(STREAM_END_REASON_TIMEOUT);
  s2.recordError("bad json");
  s2.recordError("write failed");
  assert.match(s2.summary(), /reason=timeout/);
  assert.match(s2.summary(), /soft_errors=2/);
});

test("original StreamScanner [DONE] vs eof end_reason", () => {
  const done = new StreamStatus();
  applySseScannerEndReason(done, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n');
  assert.equal(done.endReason, STREAM_END_REASON_DONE);
  assert.equal(done.isNormalEnd(), true);
  assert.equal(done.hasErrors(), false);

  const eof = new StreamStatus();
  applySseScannerEndReason(eof, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n');
  assert.equal(eof.endReason, STREAM_END_REASON_EOF);
  assert.equal(eof.isNormalEnd(), true);
});
