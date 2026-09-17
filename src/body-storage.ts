/**
 * Original `common.BodyStorage` / `GetRequestBody` / `CleanupBodyStorage` and
 * `middleware.BodyStorageCleanup` (`service.CleanupFileSources` after Close).
 * `SetApiRouter` group Use, `SetRelayRouter` engine Use, plugin inner engine Use.
 *
 * Extra-OK: workerd has no `os.File`; disk cache stays memory even when
 * `performance_setting.disk_cache_enabled` is true (original already falls
 * back to memory when disk create fails; the default is disabled).
 * Extra-OK: cleanup runs after every worker request (no-op when unset),
 * including dashboard/web where original engine Use may not wrap the group.
 */
import { envOrDefaultInt, MAX_REQUEST_BODY_MB } from "./constants.js";
import type { Env } from "./types.js";

/** Original `common.KeyBodyStorage`. */
export const KEY_BODY_STORAGE = "key_body_storage";

/** Original `constant.ContextKeyFileSourcesToCleanup`. */
export const KEY_FILE_SOURCES_TO_CLEANUP = "file_sources_to_cleanup";

/** Original `common.ErrRequestBodyTooLarge`. */
export const ERR_REQUEST_BODY_TOO_LARGE = "request body too large";

/** Original `common.ErrStorageClosed`. */
export const ERR_STORAGE_CLOSED = "body storage is closed";

/** Original `types.ErrorCodeReadRequestBodyFailed`. */
export const ERROR_CODE_READ_REQUEST_BODY_FAILED = "read_request_body_failed";

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super(ERR_REQUEST_BODY_TOO_LARGE);
    this.name = "RequestBodyTooLargeError";
  }
}

export class StorageClosedError extends Error {
  constructor() {
    super(ERR_STORAGE_CLOSED);
    this.name = "StorageClosedError";
  }
}

/**
 * Original `errors.Wrap(ErrRequestBodyTooLarge, fmt.Sprintf("request body exceeds %d MB", maxMB))`.
 */
export class WrappedRequestBodyTooLargeError extends Error {
  override readonly cause: Error;
  constructor(maxMB: number, cause: Error = new RequestBodyTooLargeError()) {
    super(`request body exceeds ${maxMB} MB: ${cause.message}`);
    this.name = "WrappedRequestBodyTooLargeError";
    this.cause = cause;
  }
}

export function isRequestBodyTooLargeError(err: unknown): boolean {
  if (err instanceof RequestBodyTooLargeError) return true;
  if (err instanceof WrappedRequestBodyTooLargeError) return true;
  return false;
}

export type BodyStorage = {
  bytes(): Uint8Array;
  size(): number;
  isDisk(): boolean;
  close(): void;
  seek(offset: number, whence: number): number;
  read(p: Uint8Array): number;
  newReader(): Uint8Array;
};

export type FileSourceCleanup = {
  isRegistered?: boolean;
  getCache(): { close(): void } | null | undefined;
};

export type DiskCacheStats = {
  activeDiskFiles: number;
  currentDiskUsageBytes: number;
  activeMemoryBuffers: number;
  currentMemoryUsageBytes: number;
  diskCacheHits: number;
  memoryCacheHits: number;
};

type BodyCleanupContext = {
  storage: BodyStorage | null;
  fileSources: FileSourceCleanup[];
  maxRequestBodyMB: number;
};

const requestBodyCleanup = new WeakMap<Request, BodyCleanupContext>();

const diskCacheStats: DiskCacheStats = {
  activeDiskFiles: 0,
  currentDiskUsageBytes: 0,
  activeMemoryBuffers: 0,
  currentMemoryUsageBytes: 0,
  diskCacheHits: 0,
  memoryCacheHits: 0,
};

/** Original `common.GetRequestBody` default when `MaxRequestBodyMB <= 0` (128, not decompress 32). */
export const GET_REQUEST_BODY_MAX_MB_FALLBACK = 128;

/** Original `constant.MaxRequestBodyMB` then `if maxMB <= 0 { maxMB = 128 }`. */
export function getRequestBodyMaxMB(env?: Pick<Env, "MAX_REQUEST_BODY_MB">): number {
  let maxMB = envOrDefaultInt(env?.MAX_REQUEST_BODY_MB, MAX_REQUEST_BODY_MB);
  if (maxMB <= 0) maxMB = GET_REQUEST_BODY_MAX_MB_FALLBACK;
  return maxMB;
}

export function getDiskCacheStats(): DiskCacheStats {
  return { ...diskCacheStats };
}

/** Original `common.ResetDiskCacheStats` (hits only, not current usage). */
export function resetDiskCacheStats(): void {
  diskCacheStats.diskCacheHits = 0;
  diskCacheStats.memoryCacheHits = 0;
}

export function incrementMemoryBuffers(size: number): void {
  diskCacheStats.activeMemoryBuffers += 1;
  diskCacheStats.currentMemoryUsageBytes += size;
}

export function decrementMemoryBuffers(size: number): void {
  diskCacheStats.activeMemoryBuffers -= 1;
  diskCacheStats.currentMemoryUsageBytes -= size;
}

export function incrementMemoryCacheHits(): void {
  diskCacheStats.memoryCacheHits += 1;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Original `io.ReadAll(io.LimitReader(reader, maxBytes+1))`.
 * Throws `RequestBodyTooLargeError` when the capped read exceeds `maxBytes`.
 */
export async function readLimitedBodyBytes(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cap = maxBytes + 1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const next = total + value.byteLength;
      if (next > cap) {
        const take = cap - total;
        if (take > 0) chunks.push(value.subarray(0, take));
        total = cap;
        break;
      }
      chunks.push(value);
      total = next;
      if (total >= cap) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed or failed */
    }
  }
  const data = concatBytes(chunks, total);
  if (data.byteLength > maxBytes) throw new RequestBodyTooLargeError();
  return data;
}

function newMemoryStorage(data: Uint8Array): BodyStorage {
  const size = data.byteLength;
  incrementMemoryBuffers(size);
  let offset = 0;
  let closed = false;
  return {
    bytes() {
      if (closed) throw new StorageClosedError();
      return data;
    },
    size() {
      return size;
    },
    isDisk() {
      return false;
    },
    close() {
      if (closed) return;
      closed = true;
      decrementMemoryBuffers(size);
    },
    seek(off: number, whence: number) {
      if (closed) throw new StorageClosedError();
      let next = offset;
      if (whence === 0) next = off;
      else if (whence === 1) next = offset + off;
      else if (whence === 2) next = size + off;
      if (next < 0) throw new Error("negative position");
      offset = next;
      return offset;
    },
    read(p: Uint8Array) {
      if (closed) throw new StorageClosedError();
      const n = Math.min(p.byteLength, size - offset);
      if (n <= 0) return 0;
      p.set(data.subarray(offset, offset + n));
      offset += n;
      return n;
    },
    newReader() {
      if (closed) throw new StorageClosedError();
      return data;
    },
  };
}

/** Original `common.CreateBodyStorage`. Extra-OK: always memory (no disk files). */
export function createBodyStorage(data: Uint8Array): BodyStorage {
  return newMemoryStorage(data);
}

/** Original `common.CreateBodyStorageFromReader` memory path + `IncrementMemoryCacheHits`. */
export async function createBodyStorageFromReader(
  reader: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BodyStorage> {
  const data = reader ? await readLimitedBodyBytes(reader, maxBytes) : new Uint8Array();
  const storage = createBodyStorage(data);
  if (!storage.isDisk()) incrementMemoryCacheHits();
  return storage;
}

export function rememberBodyCleanupContext(
  req: Request,
  env?: Pick<Env, "MAX_REQUEST_BODY_MB">,
): BodyCleanupContext {
  let ctx = requestBodyCleanup.get(req);
  if (!ctx) {
    ctx = { storage: null, fileSources: [], maxRequestBodyMB: getRequestBodyMaxMB(env) };
    requestBodyCleanup.set(req, ctx);
  } else if (env) {
    ctx.maxRequestBodyMB = getRequestBodyMaxMB(env);
  }
  return ctx;
}

/** Copy the shared cleanup context onto a reconstructed Request. */
export function carryRequestBodyCleanup(from: Request, to: Request): Request {
  const ctx = requestBodyCleanup.get(from);
  if (ctx) requestBodyCleanup.set(to, ctx);
  return to;
}

/**
 * Original `common.GetRequestBody` / `GetBodyStorage`.
 * Too-large is wrapped `request body exceeds %d MB: request body too large`.
 */
export async function getRequestBody(req: Request, env?: Pick<Env, "MAX_REQUEST_BODY_MB">): Promise<BodyStorage> {
  const ctx = rememberBodyCleanupContext(req, env);
  if (ctx.storage) {
    ctx.storage.seek(0, 0);
    return ctx.storage;
  }
  const maxMB = ctx.maxRequestBodyMB;
  const maxBytes = maxMB << 20;
  try {
    const storage = await createBodyStorageFromReader(req.body, maxBytes);
    ctx.storage = storage;
    return storage;
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      throw new WrappedRequestBodyTooLargeError(maxMB, err);
    }
    throw err;
  }
}

export function getBodyStorage(req: Request, env?: Pick<Env, "MAX_REQUEST_BODY_MB">): Promise<BodyStorage> {
  return getRequestBody(req, env);
}

/** Original `common.CleanupBodyStorage`. */
export function cleanupBodyStorage(req: Request): void {
  const ctx = requestBodyCleanup.get(req);
  if (!ctx || ctx.storage == null) return;
  ctx.storage.close();
  ctx.storage = null;
}

/** Original `service.registerSourceForCleanup`. */
export function registerSourceForCleanup(req: Request, source: FileSourceCleanup): void {
  if (source.isRegistered) return;
  const ctx = rememberBodyCleanupContext(req);
  ctx.fileSources.push(source);
  source.isRegistered = true;
}

/** Original `service.CleanupFileSources`. */
export function cleanupFileSources(req: Request): void {
  const ctx = requestBodyCleanup.get(req);
  if (!ctx) return;
  for (const source of ctx.fileSources) {
    const cache = source.getCache();
    if (cache) cache.close();
  }
  ctx.fileSources = [];
}

/** Original `middleware.BodyStorageCleanup` defer after `c.Next()`. */
export function emitBodyStorageCleanup(req: Request): void {
  cleanupBodyStorage(req);
  cleanupFileSources(req);
}

export function storageBytesToArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}
