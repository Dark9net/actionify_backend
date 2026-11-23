/**
 * How much the studio's Cloudflare R2 holds and how many operations it has served this billing
 * month, against what the plan includes (config/env.js: R2_PLAN_*, defaults R2's free tier).
 *
 * With CLOUDFLARE_API_TOKEN set (Account Analytics: Read), everything comes from Cloudflare's GraphQL
 * Analytics API, the numbers the Cloudflare dashboard and the bill use:
 *   r2StorageAdaptiveGroups      stored bytes and objects, sampled through the day, per bucket
 *   r2OperationsAdaptiveGroups   requests per action (PutObject, GetObject…), per bucket
 * Storage is billed in GB-month: each day's peak, averaged over 30 days. The free tier and the
 * operation counts are for the whole account, so every bucket is added up; this bucket's own share
 * is reported beside it.
 *
 * Cloudflare samples storage only now and then, often an hour or more behind, so what this bucket
 * holds right now is counted by listing it (one Class A operation per 1000 files), at most every 30
 * minutes (or a minute, on refresh). Without the token, that listing is all there is: no operations.
 *
 * Answers are kept for R2_USAGE_CACHE (default 5 minutes): Cloudflare's analytics trail a few
 * minutes behind anyway. When Cloudflare can't be asked, the last answer is returned, marked stale.
 */
const env = require("../config/env")
const { r2, bucket, bucketTotals, describeR2Error } = require("../config/r2config")
const { HttpError } = require("../utils/http-error")

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
const ROW_LIMIT = 10_000
const DAY = 86_400_000
const MINUTE = 60_000

// developers.cloudflare.com/r2/pricing: which actions count as which class.
const CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
])
const CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
])
const FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"])
// Requests refused for their credentials or permissions are not charged.
const NOT_CHARGED = new Set([401, 403])

const QUERY = `query R2Usage($account: string!, $start: Time!, $end: Time!, $storageFrom: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      operations: r2OperationsAdaptiveGroups(
        limit: ${ROW_LIMIT}
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests }
        dimensions { actionType bucketName responseStatusCode }
      }
      storage: r2StorageAdaptiveGroups(
        limit: ${ROW_LIMIT}
        filter: { datetime_geq: $storageFrom, datetime_leq: $end }
        orderBy: [datetime_DESC]
      ) {
        max { objectCount uploadCount payloadSize metadataSize }
        dimensions { bucketName datetime }
      }
    }
  }
}`

/** The account the bucket belongs to: R2_ACCOUNT_ID, or the first part of the S3 endpoint's host. */
function accountTag() {
  if (env.R2_ACCOUNT_ID) return env.R2_ACCOUNT_ID
  if (env.R2_ENDPOINT) return new URL(env.R2_ENDPOINT).hostname.split(".")[0]
  return ""
}

/** The bucket as analytics name it: buckets with a jurisdiction carry it in front ("eu_photos"). */
const analyticsBucket = () => (env.R2_JURISDICTION ? `${env.R2_JURISDICTION}_${bucket}` : bucket)

/** The billing month that holds `now`: from R2_BILLING_DAY (UTC) to the same day a month later. */
function billingPeriod(now = new Date()) {
  const day = env.R2_BILLING_DAY
  const month = now.getUTCMonth() - (now.getUTCDate() < day ? 1 : 0)
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), month, day)),
    end: new Date(Date.UTC(now.getUTCFullYear(), month + 1, day)),
  }
}

/** RFC 3339 to the second, as the analytics API takes it. */
const rfc3339 = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z")

const meter = (used, included) => ({
  used,
  included,
  remaining: Math.max(0, included - used),
  over: Math.max(0, used - included),
})

/* ---------- Cloudflare's analytics ---------- */

async function askCloudflare(variables) {
  let res
  try {
    res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(err.name === "TimeoutError" ? "Cloudflare's analytics didn't answer in time." : "Cloudflare's analytics can't be reached from the API.", {
      cause: err,
    })
  }

  const body = await res.json().catch(() => null)
  const errors = body?.errors ?? []
  const refused =
    res.status === 401 ||
    res.status === 403 ||
    errors.some((e) => /auth|permission|not authorized|forbidden|access/i.test(`${e.message} ${e.extensions?.code ?? ""}`))
  if (refused) {
    throw new Error("Cloudflare refused CLOUDFLARE_API_TOKEN: it needs the permission Account > Account Analytics > Read for this account.")
  }
  if (!res.ok || errors.length) {
    const reason = errors[0]?.message ? `: ${String(errors[0].message).slice(0, 200)}` : ` (HTTP ${res.status})`
    throw new Error(`Cloudflare's analytics answered with an error${reason}`)
  }
  const account = body?.data?.viewer?.accounts?.[0]
  if (!account) throw new Error("CLOUDFLARE_API_TOKEN can't see this account: check R2_ACCOUNT_ID and the token's account.")
  return account
}

/** Requests this period, by class, for the account and for this bucket. */
function countOperations(rows, ownBucket) {
  const total = { a: 0, b: 0, free: 0, notCharged: 0 }
  const own = { a: 0, b: 0 }
  const other = new Map()
  for (const row of rows) {
    const n = Number(row.sum?.requests) || 0
    const { actionType: action, bucketName, responseStatusCode } = row.dimensions ?? {}
    if (NOT_CHARGED.has(Number(responseStatusCode))) {
      total.notCharged += n
      continue
    }
    const mine = bucketName === ownBucket
    if (CLASS_A.has(action)) {
      total.a += n
      if (mine) own.a += n
    } else if (CLASS_B.has(action)) {
      total.b += n
      if (mine) own.b += n
    } else if (FREE.has(action)) {
      total.free += n
    } else {
      other.set(action || "Unknown", (other.get(action || "Unknown") ?? 0) + n)
    }
  }
  return { total, own, other: [...other].map(([action, requests]) => ({ action, requests })) }
}

/**
 * What is stored now (the newest sample of each bucket), this bucket's share, and the GB-month so
 * far: each day's peak (a day without a sample keeps the day before's), added up over 30.
 */
function measureStorage(rows, { start, now, ownBucket }) {
  const byBucket = new Map() // bucket → samples, oldest first
  for (const row of [...rows].reverse()) {
    const name = row.dimensions?.bucketName ?? ""
    const m = row.max ?? {}
    const sample = {
      at: Date.parse(row.dimensions?.datetime),
      bytes: (Number(m.payloadSize) || 0) + (Number(m.metadataSize) || 0),
      objects: Number(m.objectCount) || 0,
      uploads: Number(m.uploadCount) || 0,
    }
    if (!Number.isFinite(sample.at)) continue
    if (!byBucket.has(name)) byBucket.set(name, [])
    byBucket.get(name).push(sample)
  }

  const firstDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  const days = Math.max(1, Math.floor((now - firstDay) / DAY) + 1)
  const dayTotals = new Array(days).fill(0)
  let used = 0
  let objects = 0
  let uploads = 0
  let measuredAt = null
  let own = { bytes: 0, objects: 0 }

  for (const [name, samples] of byBucket) {
    const latest = samples[samples.length - 1]
    used += latest.bytes
    objects += latest.objects
    uploads += latest.uploads
    if (!measuredAt || latest.at > measuredAt) measuredAt = latest.at
    if (name === ownBucket) own = { bytes: latest.bytes, objects: latest.objects }

    // the peak of each day of the period; before the first sample in it, the last one before it
    const peaks = new Array(days).fill(null)
    let before = 0
    for (const s of samples) {
      const i = Math.floor((s.at - firstDay) / DAY)
      if (i < 0) before = s.bytes
      else if (i < days) peaks[i] = Math.max(peaks[i] ?? 0, s.bytes)
    }
    let carried = before
    for (let i = 0; i < days; i++) {
      if (peaks[i] === null) peaks[i] = carried
      carried = peaks[i]
      dayTotals[i] += peaks[i]
    }
  }

  const byteMonths = dayTotals.reduce((a, b) => a + b, 0) / 30
  return { used, objects, uploads, own, measuredAt, byteMonths }
}

async function fromAnalytics(now, refresh) {
  const { start, end } = billingPeriod(now)
  // a couple of days back too, so a fresh period still knows what was stored before it began
  const storageFrom = new Date(Math.min(start.getTime(), now.getTime() - 2 * DAY))
  const [account, listing] = await Promise.all([
    askCloudflare({
      account: accountTag(),
      start: rfc3339(start),
      end: rfc3339(now),
      storageFrom: rfc3339(storageFrom),
    }),
    listOwnBucket(refresh),
  ])

  const ownBucket = analyticsBucket()
  const operations = account.operations ?? []
  const storageRows = account.storage ?? []
  const ops = countOperations(operations, ownBucket)
  const stored = measureStorage(storageRows, { start, now, ownBucket })

  // Cloudflare samples storage only now and then (often an hour or more behind), so what this bucket
  // holds right now comes from listing it; the other buckets keep their newest sample.
  let { used, objects, measuredAt } = stored
  let own = stored.own
  if (listing && (listing.totals.complete || listing.totals.bytes > own.bytes)) {
    used += listing.totals.bytes - own.bytes
    objects += listing.totals.objects - own.objects
    own = { bytes: listing.totals.bytes, objects: listing.totals.objects }
    measuredAt = listing.at
  }

  // the rest of the period at today's size, for an estimate of the month's GB-month
  const daysLeft = Math.max(0, (end - now) / DAY)
  const projected = stored.byteMonths + (used * daysLeft) / 30

  return {
    source: "cloudflare",
    period: { start: start.toISOString(), end: end.toISOString() },
    storage: {
      ...meter(used, env.R2_PLAN_STORAGE_BYTES),
      objects,
      pendingUploads: stored.uploads,
      measuredAt: measuredAt ? new Date(measuredAt).toISOString() : null,
      // "listing": this bucket counted just now; "analytics": Cloudflare's newest sample
      measuredBy: listing ? "listing" : "analytics",
      billed: { byteMonths: Math.round(stored.byteMonths), projected: Math.round(projected) },
      bucket: { name: bucket, used: own.bytes, objects: own.objects },
    },
    classA: { ...meter(ops.total.a, env.R2_PLAN_CLASS_A), bucket: ops.own.a },
    classB: { ...meter(ops.total.b, env.R2_PLAN_CLASS_B), bucket: ops.own.b },
    freeOperations: ops.total.free,
    notCharged: ops.total.notCharged,
    otherOperations: ops.other,
    // at the row limit, the oldest part of the month may be missing
    partial: operations.length >= ROW_LIMIT || storageRows.length >= ROW_LIMIT,
    note: null,
  }
}

/* ---------- Without a token: the bucket itself ---------- */

async function fromBucket(now, refresh) {
  const { start, end } = billingPeriod(now)
  const listing = await listOwnBucket(refresh, { required: true })
  const totals = listing.totals
  return {
    source: "bucket",
    period: { start: start.toISOString(), end: end.toISOString() },
    storage: {
      ...meter(totals.bytes, env.R2_PLAN_STORAGE_BYTES),
      objects: totals.objects,
      pendingUploads: null,
      measuredAt: new Date(listing.at).toISOString(),
      measuredBy: "listing",
      billed: null,
      bucket: { name: bucket, used: totals.bytes, objects: totals.objects },
    },
    classA: null,
    classB: null,
    freeOperations: null,
    notCharged: null,
    otherOperations: [],
    partial: !totals.complete,
    note: "Operations need CLOUDFLARE_API_TOKEN (Account Analytics: Read) in backend/.env; the size is this bucket's only.",
  }
}

/* ---------- Kept answers ---------- */

const BUCKET_CACHE_MS = 30 * MINUTE
const REFRESH_AFTER_MS = MINUTE // ?refresh=1 asks again at most once a minute
const KEEP_STALE_MS = DAY

let kept = null // { at, value }
let failed = null // { at, message }: the last failed ask, so an outage is asked about once a minute
let asking = null

/**
 * This bucket's size, by listing it (one Class A operation per 1000 files), kept for 30 minutes or,
 * with `refresh`, for a minute. Without R2 keys, or when listing fails, null or the last listing
 * (or the error, when `required`).
 */
let listed = null // { at, totals }
async function listOwnBucket(refresh, { required = false } = {}) {
  if (!r2) return null
  const age = listed ? Date.now() - listed.at : Infinity
  if (listed && age < (refresh ? REFRESH_AFTER_MS : BUCKET_CACHE_MS)) return listed
  try {
    listed = { at: Date.now(), totals: await bucketTotals({ maxPages: 50 }) }
    return listed
  } catch (err) {
    if (required) throw new Error(`The bucket can't be listed: ${describeR2Error(err)}`, { cause: err })
    return listed
  }
}

const ttl = () => (env.CLOUDFLARE_API_TOKEN ? env.R2_USAGE_CACHE.ms : Math.max(env.R2_USAGE_CACHE.ms, BUCKET_CACHE_MS))

function plan() {
  const freeTier = env.R2_PLAN_STORAGE_BYTES === 10 * 1024 ** 3 && env.R2_PLAN_CLASS_A === 1_000_000 && env.R2_PLAN_CLASS_B === 10_000_000
  return {
    name: freeTier ? "Free tier" : "Studio plan",
    storage: env.R2_PLAN_STORAGE_BYTES,
    classA: env.R2_PLAN_CLASS_A,
    classB: env.R2_PLAN_CLASS_B,
    billingDay: env.R2_BILLING_DAY,
  }
}

/**
 * The usage, from the kept answer while it is fresh. `refresh` asks again when the kept one is
 * older than a minute.
 */
async function usage({ refresh = false } = {}) {
  const canAsk = Boolean(env.CLOUDFLARE_API_TOKEN && accountTag())
  if (!canAsk && !r2) {
    throw new HttpError(503, "Photo storage (R2) isn't set up: add the R2_* keys to backend/.env.", { code: "R2_DISABLED" })
  }

  const age = kept ? Date.now() - kept.at : Infinity
  if (kept && age < (refresh ? REFRESH_AFTER_MS : ttl())) return kept.value
  if (failed && Date.now() - failed.at < REFRESH_AFTER_MS) {
    if (kept && age < KEEP_STALE_MS) return { ...kept.value, stale: true, error: failed.message }
    throw new HttpError(502, failed.message, { code: "R2_USAGE_UNAVAILABLE" })
  }

  asking ??= (async () => {
    const now = new Date()
    try {
      const value = {
        ...(canAsk ? await fromAnalytics(now, refresh) : await fromBucket(now, refresh)),
        bucket,
        plan: plan(),
        checkedAt: now.toISOString(),
        stale: false,
        error: null,
      }
      kept = { at: now.getTime(), value }
      failed = null
      return value
    } catch (err) {
      failed = { at: Date.now(), message: err.message }
      if (kept && Date.now() - kept.at < KEEP_STALE_MS) return { ...kept.value, stale: true, error: err.message }
      throw new HttpError(502, err.message, { code: "R2_USAGE_UNAVAILABLE" })
    } finally {
      asking = null
    }
  })()
  return asking
}

module.exports = { usage, billingPeriod, countOperations, measureStorage }
