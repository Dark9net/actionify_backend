/**
 * Cloudflare R2 connection: one shared S3 client for the whole server, from the R2_* values in .env
 * (checked in config/env.js). R2 speaks the S3 API, so the AWS SDK talks to it with region "auto".
 *
 * Until R2 keys are set, `r2` is null and R2_ENABLED is false: the API still starts, and anything
 * that stores photographs should answer "storage isn't set up" instead.
 *
 *   const { r2, bucket, signedUploadUrl, signedViewUrl } = require("../config/r2config")
 *   const url = await signedUploadUrl("events/anna-leo/ceremony/IMG_0001.jpg", { contentType: "image/jpeg" })
 *
 * Browsers upload and view photographs through short-lived signed links, so the bucket stays
 * private and the files never pass through this server. A large file goes up in parts, each part
 * through its own link (startMultipart, signedPartUrl, listParts, finishMultipart, abortMultipart).
 */
const {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
} = require("@aws-sdk/client-s3")
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")
const env = require("./env")

const bucket = env.R2_BUCKET
/** bucket@host for messages (the keys are never printed). */
const target = env.R2_ENABLED ? `${bucket} on ${new URL(env.R2_ENDPOINT).hostname}` : "R2"

const r2 = env.R2_ENABLED
  ? new S3Client({
      region: "auto",
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      // <endpoint>/<bucket>/<key>: R2's certificate covers <account>.r2.cloudflarestorage.com, not
      // <bucket>.<account>.r2…, so the bucket goes in the path.
      forcePathStyle: true,
      // Checksums only where S3 requires them: R2 doesn't accept every checksum newer SDKs add.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    })
  : null

/** Plain-language reason for a failed request (never includes the keys). */
function describe(err) {
  const status = err?.$metadata?.httpStatusCode
  // S3 errors carry their reason in `name`; network errors in `code` (with name "Error").
  const name = err?.name && err.name !== "Error" ? err.name : (err?.code ?? err?.Code ?? err?.name)
  switch (name) {
    case "InvalidAccessKeyId":
      return "R2 doesn't know the Access Key ID in R2_ACCESS_KEY"
    case "SignatureDoesNotMatch":
      return "R2_SECRET_ACCESS_KEY doesn't belong to R2_ACCESS_KEY"
    case "NoSuchBucket":
      return `there is no bucket "${bucket}" in this account (R2_BUCKET_NAME)`
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `the R2 address can't be found (${env.R2_ENDPOINT}); check R2_ACCOUNT_ID`
    case "EPROTO":
    case "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE":
      return `R2 refused the secure connection to ${env.R2_ENDPOINT}; check R2_ACCOUNT_ID (or R2_ENDPOINT)`
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "TimeoutError":
    case "RequestTimeout":
      return `R2 didn't answer (${target})`
  }
  // HEAD requests come back without a body, so only the status says what went wrong.
  if (status === 404) return `there is no bucket "${bucket}" in this account (R2_BUCKET_NAME)`
  if (status === 401 || status === 403) {
    return `R2 refused the keys for "${bucket}"; check R2_ACCESS_KEY / R2_SECRET_ACCESS_KEY and that the token may use this bucket`
  }
  return `${name ?? "error"}${status ? ` (HTTP ${status})` : ""}: ${err?.message ?? String(err)}`
}

/** Refuses keys that could escape their folder or that R2 would store oddly. */
function cleanKey(key) {
  const value = String(key ?? "")
  if (!value || value.length > 1024 || value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Not a usable R2 object key: "${value.slice(0, 80)}"`)
  }
  return value
}

function requireR2() {
  if (!r2) throw Object.assign(new Error("Photo storage (R2) isn't set up: add the R2_* keys to backend/.env."), { code: "R2_DISABLED" })
  return r2
}

const seconds = (ms) => Math.max(1, Math.round(ms / 1000))

/**
 * A link a browser can PUT one file to, until it expires. The upload must send the same
 * Content-Type header as `contentType`, and with `size` exactly that many bytes, or R2 refuses it.
 */
function signedUploadUrl(key, { contentType, size, expiresIn = env.R2_SIGNED_URL_EXPIRES_IN.ms } = {}) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: cleanKey(key),
    ContentType: contentType,
    ...(size !== undefined && { ContentLength: size }),
  })
  // content-type is left out of the signature unless asked for; signed, a file sent as another type is refused
  return getSignedUrl(requireR2(), command, { expiresIn: seconds(expiresIn), signableHeaders: new Set(["content-type"]) })
}

// View links are signed as of the start of a 10-minute window: the same file gets the same link for
// those ten minutes, so the browser shows a preview it has already downloaded instead of fetching it again.
const VIEW_WINDOW_MS = 10 * 60_000

/** A link to view (or, with `downloadAs`, download) one file, for at least `expiresIn`. */
function signedViewUrl(key, { downloadAs, expiresIn = env.R2_SIGNED_URL_EXPIRES_IN.ms } = {}) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: cleanKey(key),
    ...(downloadAs && {
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(downloadAs)}`,
    }),
  })
  const now = Date.now()
  return getSignedUrl(requireR2(), command, {
    signingDate: new Date(now - (now % VIEW_WINDOW_MS)),
    expiresIn: seconds(expiresIn + VIEW_WINDOW_MS),
  })
}

/** Stores a small file the server itself has checked (a profile photo): `body` is a Buffer. */
function putObject(key, body, { contentType, cacheControl } = {}) {
  return requireR2().send(
    new PutObjectCommand({ Bucket: bucket, Key: cleanKey(key), Body: body, ContentType: contentType, CacheControl: cacheControl, ContentLength: body.length }),
  )
}

/** A small file's bytes and type (the studio's payment QR, to attach to an email): { body: Buffer, contentType }. */
async function getObjectBuffer(key) {
  const out = await requireR2().send(new GetObjectCommand({ Bucket: bucket, Key: cleanKey(key) }))
  return { body: Buffer.from(await out.Body.transformToByteArray()), contentType: out.ContentType ?? null }
}

/** What R2 holds under `key`: { size, etag, contentType }, or null when there is nothing there. */
async function headObject(key) {
  try {
    const head = await requireR2().send(new HeadObjectCommand({ Bucket: bucket, Key: cleanKey(key) }))
    return { size: Number(head.ContentLength), etag: head.ETag?.replace(/"/g, "") ?? null, contentType: head.ContentType ?? null }
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return null
    throw err
  }
}

/**
 * The first `bytes` bytes of what R2 holds under `key` (one ranged GET, the same price as a HEAD), with
 * the whole file's size: { head: Buffer, size, etag, contentType }, or null when there is nothing there.
 */
async function readObjectStart(key, bytes) {
  try {
    const out = await requireR2().send(new GetObjectCommand({ Bucket: bucket, Key: cleanKey(key), Range: `bytes=0-${Math.max(0, bytes - 1)}` }))
    const head = Buffer.from(await out.Body.transformToByteArray())
    // "bytes 0-65535/12345678": the total after the slash; a small file comes back whole
    const total = Number(/\/(\d+)$/.exec(out.ContentRange ?? "")?.[1] ?? out.ContentLength)
    return { head, size: total, etag: out.ETag?.replace(/"/g, "") ?? null, contentType: out.ContentType ?? null }
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode
    if (status === 404 || err?.name === "NoSuchKey" || err?.name === "NotFound") return null
    if (status === 416) return { head: Buffer.alloc(0), size: 0, etag: null, contentType: null } // an empty file
    throw err
  }
}

/* ---------- Large files, in parts (multipart upload) ---------- */

/*
  A file too large for one PUT goes up as numbered parts (1…10,000), each PUT by the browser to its own
  signed link. R2 keeps every part it receives until the upload is completed (joined into one file) or
  aborted, so a part that failed is simply sent again and the others stay. All parts but the last must be
  the same size. R2 aborts an upload left unfinished for 7 days by itself.
*/

// joining thousands of parts can take R2 a while
const JOIN_TIMEOUT_MS = 10 * 60_000

const goneUpload = (err) =>
  err?.name === "NoSuchUpload" || err?.Code === "NoSuchUpload" || err?.$metadata?.httpStatusCode === 404

/** Opens an upload in parts for `key`; resolves with its UploadId. */
async function startMultipart(key, { contentType } = {}) {
  const out = await requireR2().send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: cleanKey(key), ContentType: contentType }))
  return out.UploadId
}

/** A link a browser can PUT part `partNumber` to (exactly `size` bytes), until it expires. */
function signedPartUrl(key, { uploadId, partNumber, size, expiresIn = env.R2_SIGNED_URL_EXPIRES_IN.ms }) {
  const command = new UploadPartCommand({ Bucket: bucket, Key: cleanKey(key), UploadId: uploadId, PartNumber: partNumber, ContentLength: size })
  return getSignedUrl(requireR2(), command, { expiresIn: seconds(expiresIn) })
}

/**
 * The parts R2 holds of an unfinished upload: [{ number, size, etag }] by number (1000 per request),
 * or null when there is no such upload any more (completed, aborted, or expired after 7 days).
 */
async function listParts(key, uploadId) {
  const client = requireR2()
  const parts = []
  let marker
  try {
    for (;;) {
      const out = await client.send(
        new ListPartsCommand({ Bucket: bucket, Key: cleanKey(key), UploadId: uploadId, MaxParts: 1000, PartNumberMarker: marker }),
      )
      for (const p of out.Parts ?? []) parts.push({ number: p.PartNumber, size: Number(p.Size), etag: p.ETag })
      if (!out.IsTruncated) break
      marker = out.NextPartNumberMarker
    }
  } catch (err) {
    if (goneUpload(err)) return null
    throw err
  }
  return parts.sort((a, b) => a.number - b.number)
}

/** Joins the parts ([{ number, etag }], every one from 1) into the one file at `key`. */
async function finishMultipart(key, uploadId, parts) {
  const out = await requireR2().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: cleanKey(key),
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.number, ETag: p.etag })) },
    }),
    { requestTimeout: JOIN_TIMEOUT_MS },
  )
  return { etag: out.ETag?.replace(/"/g, "") ?? null }
}

/** Drops an unfinished upload and every part of it (no error when it's already gone). */
async function abortMultipart(key, uploadId) {
  try {
    await requireR2().send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: cleanKey(key), UploadId: uploadId }))
  } catch (err) {
    if (!goneUpload(err)) throw err
  }
}

/** Removes one file (no error when it's already gone). */
function removeObject(key) {
  return requireR2().send(new DeleteObjectCommand({ Bucket: bucket, Key: cleanKey(key) }))
}

/**
 * Removes many files, 1000 per request. Resolves with the keys R2 couldn't remove (empty when all went).
 * A key that was already gone counts as removed.
 */
async function removeObjects(keys) {
  const client = requireR2()
  const list = [...new Set(keys.filter(Boolean).map(cleanKey))]
  const failed = []
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000)
    const out = await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }),
    )
    for (const e of out.Errors ?? []) if (e.Code !== "NoSuchKey") failed.push(e.Key)
  }
  return failed
}

/**
 * Empties a folder ("events/anna-leo/"): every upload in parts that never finished is dropped, then
 * every file under it is removed, 1000 per request. Resolves with { removed, failed } (the keys R2
 * couldn't remove; empty when all went). Only a whole folder name is taken, never the bucket's root.
 */
async function removeFolder(prefix) {
  const client = requireR2()
  const folder = `${cleanKey(String(prefix ?? "").replace(/\/+$/, ""))}/`
  let keyMarker
  let uploadIdMarker
  do {
    const out = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: folder, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }),
    )
    for (const u of out.Uploads ?? []) await abortMultipart(u.Key, u.UploadId)
    keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined
    uploadIdMarker = out.IsTruncated ? out.NextUploadIdMarker : undefined
  } while (keyMarker)

  let removed = 0
  const failed = []
  let token
  do {
    const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: folder, MaxKeys: 1000, ContinuationToken: token }))
    const keys = (out.Contents ?? []).map((o) => o.Key)
    if (keys.length) {
      const missed = await removeObjects(keys)
      failed.push(...missed)
      removed += keys.length - missed.length
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined
  } while (token)
  return { removed, failed }
}

/**
 * What the bucket holds, counted by listing it: { bytes, objects, complete }. Each page of 1000 keys
 * is one ListObjects request (a Class A operation), so at most `maxPages` are read; `complete` is
 * false when the bucket has more than that.
 */
async function bucketTotals({ maxPages = 50 } = {}) {
  requireR2()
  let bytes = 0
  let objects = 0
  let token
  for (let page = 0; page < maxPages; page++) {
    const out = await r2.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: token }))
    for (const o of out.Contents ?? []) {
      bytes += o.Size ?? 0
      objects++
    }
    if (!out.IsTruncated) return { bytes, objects, complete: true }
    token = out.NextContinuationToken
  }
  return { bytes, objects, complete: false }
}

/**
 * Checks the bucket at startup. Resolves { enabled: false } while R2 is off, or
 * { enabled: true, target } once the bucket answers. Throws with a readable reason otherwise.
 */
async function connectR2() {
  if (!r2) return { enabled: false }
  try {
    await r2.send(new HeadBucketCommand({ Bucket: bucket }))
    return { enabled: true, target }
  } catch (err) {
    throw new Error(`Can't reach R2: ${describe(err)}`, { cause: err })
  }
}

// A health check every few seconds would cost an R2 request each time: the answer is kept briefly.
const PING_CACHE_MS = 30_000
let lastPing = { at: 0, state: "down" }

/** "up", "down", or "disabled" (for health checks). */
async function pingR2() {
  if (!r2) return "disabled"
  if (Date.now() - lastPing.at < PING_CACHE_MS) return lastPing.state
  const state = await r2.send(new HeadBucketCommand({ Bucket: bucket })).then(
    () => "up",
    () => "down",
  )
  lastPing = { at: Date.now(), state }
  return state
}

/** Closes the client's open sockets on shutdown. */
function closeR2() {
  r2?.destroy()
}

module.exports = {
  r2,
  bucket,
  signedUploadUrl,
  signedViewUrl,
  putObject,
  getObjectBuffer,
  headObject,
  readObjectStart,
  removeObject,
  removeObjects,
  removeFolder,
  startMultipart,
  signedPartUrl,
  listParts,
  finishMultipart,
  abortMultipart,
  bucketTotals,
  connectR2,
  pingR2,
  closeR2,
  describeR2Error: describe,
}
