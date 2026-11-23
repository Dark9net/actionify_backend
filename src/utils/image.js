/**
 * What an uploaded image really is, read from its bytes (never from the name or the Content-Type the
 * browser claims): the type, and its width and height from the header. Profile photos use it
 * (services/profile-photo.js) to refuse anything that isn't a JPEG, PNG or WebP of a sane size.
 */

/** "image/jpeg" | "image/png" | "image/webp" | null */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  return null
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function webpSize(buf) {
  if (buf.length < 30) return null
  const chunk = buf.toString("ascii", 12, 16)
  if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  return null
}

// the start-of-frame markers that carry the size (not DHT C4, JPG C8 or DAC CC)
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    const length = buf.readUInt16BE(i + 2)
    if (SOF.has(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

/** { type, width, height }, or null when the bytes aren't a JPEG, PNG or WebP whose size can be read. */
function inspect(buf) {
  const type = sniff(buf)
  if (!type) return null
  const size = type === "image/png" ? pngSize(buf) : type === "image/webp" ? webpSize(buf) : jpegSize(buf)
  if (!size || !size.width || !size.height) return null
  return { type, ...size }
}

module.exports = { inspect, sniff }
