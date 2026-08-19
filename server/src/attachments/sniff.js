/** Server-side content sniffing for uploaded attachments — NEVER trust the client's
 * Content-Type header. Only these four image formats (intersection of what the three
 * vision providers accept) and strict-UTF-8-decodable text are supported; everything
 * else is unsupported_type (415), no PDFs/binaries in v1. */

const MAGIC = [
  {
    mediaType: 'image/png',
    test: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  },
  {
    mediaType: 'image/jpeg',
    test: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mediaType: 'image/gif',
    test: (buf) =>
      buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38,
  },
  {
    mediaType: 'image/webp',
    test: (buf) =>
      buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP',
  },
];

const EXT_BY_MEDIA_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function sniffImage(buf) {
  for (const m of MAGIC) {
    if (m.test(buf)) return m.mediaType;
  }
  return null;
}

function isStrictUtf8Text(buf) {
  if (buf.includes(0)) return false; // NUL bytes disqualify — treat as binary
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Returns {kind:'image', mediaType} | {kind:'text', mediaType:'text/plain'} | null (unsupported). */
function sniffAttachment(buf) {
  const imageMediaType = sniffImage(buf);
  if (imageMediaType) return { kind: 'image', mediaType: imageMediaType };
  if (isStrictUtf8Text(buf)) return { kind: 'text', mediaType: 'text/plain' };
  return null;
}

export { sniffAttachment, EXT_BY_MEDIA_TYPE };
