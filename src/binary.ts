// @verevoir/sources — content classification, shared by every adapter that
// decodes a file's raw bytes before returning it to a caller.
//
// A plain `fetch`/`fs.readFile` gives bytes; without this, every adapter
// decoded them as UTF-8 unconditionally — a PNG came back as "text" (invalid
// sequences silently replaced by U+FFFD) with no signal anything had gone
// wrong, and a UTF-16 document (full of NUL bytes by construction) risked
// the OPPOSITE mistake if a NUL check alone decided "binary". Detection is
// from the bytes THEMSELVES, never a file extension or declared
// content-type — an extension is a claim the content does not have to
// honour.
//
// Order is deliberate, and matters:
//   1. Known binary signatures (magic bytes) — a real media type, never a
//      guess.
//   2. A UTF-16 byte-order mark — this IS text, even though UTF-16 text is
//      full of NUL bytes; checked BEFORE the NUL heuristic below so it can
//      never be misclassified by it.
//   3. A NUL byte in the first 8 KiB — a cheap, generic binary signal for
//      formats with no recognised signature.
//   4. Strict UTF-8 validation (`TextDecoder`'s own `fatal: true`) — text
//      that decodes cleanly is text (SVG, JSON, Markdown, mermaid, ...);
//      text that does NOT decode cleanly is reported as binary
//      (`application/octet-stream`) instead of being silently replaced
//      with U+FFFD. This is the floor every other branch sits on top of.

export interface ClassifiedBinary {
  readonly kind: 'binary';
  readonly mediaType: string;
}
export interface ClassifiedText {
  readonly kind: 'text';
  readonly content: string;
}
export type ClassifiedContent = ClassifiedBinary | ClassifiedText;

/** How far into the content a NUL byte is still trusted as a binary signal.
 * A binary format with no recognised signature AND no NUL in this window
 * (rare, but possible) still decodes as UTF-8, same as before this module
 * existed — a floor, not a proof. */
const NUL_SCAN_WINDOW = 8192;

function bytesEqual(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (data[offset + i] !== expected[i]) return false;
  }
  return true;
}

function asciiAt(data: Uint8Array, offset: number, text: string): boolean {
  if (data.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The 4-byte brand of an ISO-base-media `ftyp` box (MP4, MOV, AVIF, HEIC, …)
 * — bytes 4-7 are literally 'ftyp', bytes 8-11 are the brand. Box size
 * (bytes 0-3) is never checked. Returns null when this isn't a `ftyp` box
 * at all, or is one too short to carry a brand. */
function ftypBrand(data: Uint8Array): string | null {
  if (!asciiAt(data, 4, 'ftyp')) return null;
  if (data.length < 12) return null;
  return String.fromCharCode(data[8], data[9], data[10], data[11]);
}

function isZip(data: Uint8Array): boolean {
  return bytesEqual(data, 0, [0x50, 0x4b, 0x03, 0x04]);
}

/** The name of the FIRST local-file-header entry in a `PK\x03\x04` zip —
 * sits right after the 30-byte fixed header, length given at offset 26 (2
 * bytes, little-endian). Never unzips, never reads an entry's content —
 * just this one name, which is enough to tell an OOXML document (docx /
 * xlsx / pptx) apart from a plain zip IF that entry happens to be
 * `word/…` / `xl/…` / `ppt/…`. Many OOXML writers put `[Content_Types].xml`
 * first instead, which this deliberately does NOT try to disambiguate
 * further — that case falls through to plain `application/zip`, per the
 * "cheap only" scope of this check. Never unzips. */
function zipFirstEntryName(data: Uint8Array): string | null {
  if (data.length < 30) return null;
  const nameLen = data[26] | (data[27] << 8);
  if (nameLen === 0 || data.length < 30 + nameLen) return null;
  return String.fromCharCode(...data.subarray(30, 30 + nameLen));
}

function zipFirstEntryStartsWith(data: Uint8Array, prefix: string): boolean {
  return (zipFirstEntryName(data) ?? '').startsWith(prefix);
}

interface Signature {
  readonly mediaType: string;
  readonly matches: (data: Uint8Array) => boolean;
}

const SIGNATURES: readonly Signature[] = [
  // Images the model can view.
  {
    mediaType: 'image/png',
    matches: (d) => bytesEqual(d, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mediaType: 'image/jpeg', matches: (d) => bytesEqual(d, 0, [0xff, 0xd8, 0xff]) },
  { mediaType: 'image/gif', matches: (d) => asciiAt(d, 0, 'GIF8') }, // GIF87a or GIF89a
  { mediaType: 'image/webp', matches: (d) => asciiAt(d, 0, 'RIFF') && asciiAt(d, 8, 'WEBP') },
  // Other images.
  { mediaType: 'image/bmp', matches: (d) => asciiAt(d, 0, 'BM') },
  { mediaType: 'image/tiff', matches: (d) => asciiAt(d, 0, 'II*\0') || asciiAt(d, 0, 'MM\0*') },
  { mediaType: 'image/x-icon', matches: (d) => bytesEqual(d, 0, [0x00, 0x00, 0x01, 0x00]) },
  { mediaType: 'image/avif', matches: (d) => ftypBrand(d) === 'avif' },
  {
    mediaType: 'image/heic',
    matches: (d) => ['heic', 'heix', 'mif1'].includes(ftypBrand(d) ?? ''),
  },
  // Documents.
  { mediaType: 'application/pdf', matches: (d) => asciiAt(d, 0, '%PDF-') },
  // ZIP-based: OOXML first (narrower), generic zip last (the catch-all).
  {
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: (d) => isZip(d) && zipFirstEntryStartsWith(d, 'word/'),
  },
  {
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    matches: (d) => isZip(d) && zipFirstEntryStartsWith(d, 'xl/'),
  },
  {
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    matches: (d) => isZip(d) && zipFirstEntryStartsWith(d, 'ppt/'),
  },
  { mediaType: 'application/zip', matches: isZip },
  // Archives.
  { mediaType: 'application/gzip', matches: (d) => bytesEqual(d, 0, [0x1f, 0x8b]) },
  {
    mediaType: 'application/x-7z-compressed',
    matches: (d) => bytesEqual(d, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  },
  { mediaType: 'application/x-tar', matches: (d) => asciiAt(d, 257, 'ustar') },
  // Media.
  {
    mediaType: 'audio/mpeg',
    matches: (d) =>
      asciiAt(d, 0, 'ID3') || (d.length >= 2 && d[0] === 0xff && (d[1] & 0xe0) === 0xe0),
  },
  { mediaType: 'audio/wav', matches: (d) => asciiAt(d, 0, 'RIFF') && asciiAt(d, 8, 'WAVE') },
  { mediaType: 'audio/ogg', matches: (d) => asciiAt(d, 0, 'OggS') },
  { mediaType: 'audio/flac', matches: (d) => asciiAt(d, 0, 'fLaC') },
  { mediaType: 'video/quicktime', matches: (d) => ftypBrand(d) === 'qt  ' },
  { mediaType: 'video/mp4', matches: (d) => ftypBrand(d) !== null },
  // Fonts.
  { mediaType: 'font/woff', matches: (d) => asciiAt(d, 0, 'wOFF') },
  { mediaType: 'font/woff2', matches: (d) => asciiAt(d, 0, 'wOF2') },
  { mediaType: 'font/ttf', matches: (d) => bytesEqual(d, 0, [0x00, 0x01, 0x00, 0x00]) },
  { mediaType: 'font/otf', matches: (d) => asciiAt(d, 0, 'OTTO') },
  // Other.
  { mediaType: 'application/vnd.sqlite3', matches: (d) => asciiAt(d, 0, 'SQLite format 3\0') },
  { mediaType: 'application/wasm', matches: (d) => bytesEqual(d, 0, [0x00, 0x61, 0x73, 0x6d]) },
  { mediaType: 'application/x-elf', matches: (d) => bytesEqual(d, 0, [0x7f, 0x45, 0x4c, 0x46]) },
  {
    mediaType: 'application/x-mach-binary',
    matches: (d) =>
      bytesEqual(d, 0, [0xfe, 0xed, 0xfa, 0xce]) ||
      bytesEqual(d, 0, [0xfe, 0xed, 0xfa, 0xcf]) ||
      bytesEqual(d, 0, [0xce, 0xfa, 0xed, 0xfe]) ||
      bytesEqual(d, 0, [0xcf, 0xfa, 0xed, 0xfe]),
  },
  { mediaType: 'application/x-msdownload', matches: (d) => asciiAt(d, 0, 'MZ') },
];

function matchSignature(data: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (sig.matches(data)) return sig.mediaType;
  }
  return null;
}

const UTF16_BOM_LE: readonly number[] = [0xff, 0xfe];
const UTF16_BOM_BE: readonly number[] = [0xfe, 0xff];

/** Classify raw bytes as a recognised binary format or as text. Never
 * throws. See the module header for the order and why it is fixed.
 *
 * The UTF-16 BOM check runs FIRST, ahead of every signature -- not just
 * ahead of the NUL heuristic. Found by testing, not by inspection: the mp3
 * frame-sync heuristic below (`0xFF` followed by a byte with its top 3 bits
 * set) also matches `0xFF 0xFE`, the UTF-16LE BOM, since `0xFE`'s top 3
 * bits are set too. A UTF-16-BOM'd file is text per this module's own
 * stated priority, so that check has to win the collision outright, not
 * merely win against the one heuristic it happened to be tested against. */
export function classifyFileContent(data: Uint8Array): ClassifiedContent {
  // A UTF-16 BOM means this IS text, even though UTF-16 text is full of NUL
  // bytes. The BOM is stripped by hand (not relied on the decoder to strip
  // it) so stripping is correct regardless of decoder behaviour for these
  // two specific labels.
  if (bytesEqual(data, 0, UTF16_BOM_LE)) {
    return { kind: 'text', content: new TextDecoder('utf-16le').decode(data.subarray(2)) };
  }
  if (bytesEqual(data, 0, UTF16_BOM_BE)) {
    return { kind: 'text', content: new TextDecoder('utf-16be').decode(data.subarray(2)) };
  }

  const signatureMediaType = matchSignature(data);
  if (signatureMediaType !== null) {
    return { kind: 'binary', mediaType: signatureMediaType };
  }

  const scanLen = Math.min(data.length, NUL_SCAN_WINDOW);
  for (let i = 0; i < scanLen; i++) {
    if (data[i] === 0) return { kind: 'binary', mediaType: 'application/octet-stream' };
  }

  // Strict UTF-8: a leading BOM is stripped by this decoder automatically
  // (ignoreBOM defaults to false); anything that does not decode cleanly
  // throws here instead of being silently replaced with U+FFFD.
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { kind: 'text', content };
  } catch {
    return { kind: 'binary', mediaType: 'application/octet-stream' };
  }
}
