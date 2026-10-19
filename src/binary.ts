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
// SIGNATURE STRENGTH. A signature match is either STRONG or WEAK, derived
// automatically from the bytes it actually matched — never set by hand, so
// a new table entry can't get it wrong. A match is STRONG if any byte it
// matched falls outside printable ASCII (0x20-0x7E); otherwise it is WEAK.
// Several real formats are identified by printable-ASCII magic bytes that
// are also ordinary English text: "BM" (bmp) opens "BMW notes"; "MZ" (the
// DOS/PE header) opens "MZ, can you review this?"; "ID3" (mp3) opens "ID3
// tags are a mess"; "OTTO" (otf), "OggS" (ogg), "fLaC" (flac), "wOFF"/"wOF2"
// (woff/woff2), "GIF87a"/"GIF89a", "%PDF-" and "ustar" (tar, at offset 257)
// have the same problem. A
// STRONG match (PNG's \x89, JPEG's FF D8 FF, gzip, ELF's \x7F, zip's
// PK\x03\x04, sqlite's trailing \0, wasm's \0asm, ...) is binary
// immediately — those byte sequences are not valid printable text to begin
// with. A WEAK match is binary only if the text floor (below) ALSO fails:
// real BMP, PE, ID3-tagged mp3, OTF and GIF files all contain NUL bytes
// early in their real structure, so they still classify correctly; a weak
// match on content that is otherwise clean, decodable text is text,
// losslessly, full stop.
//
// Order is deliberate, and matters:
//   1. A UTF-16 byte-order mark — this IS text, even though UTF-16 text is
//      full of NUL bytes; checked BEFORE any signature or the NUL
//      heuristic below so it can never be misclassified by either.
//   2. A STRONG binary signature (magic bytes) — a real media type,
//      reported immediately, never deferred to the floor.
//   3. The text floor: a NUL byte in the first 8 KiB, or a fatal UTF-8
//      decode (`TextDecoder`'s own `fatal: true`). If the floor finds
//      binary content AND a WEAK signature matched somewhere in the
//      table, that signature's media type is reported instead of the
//      generic fallback. With no signature match at all, it's
//      `application/octet-stream`.
//   4. Otherwise: text (SVG, JSON, Markdown, mermaid, and any WEAK-matched
//      content that decodes cleanly, all fall through here unchanged).

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

/** The printable-ASCII range a signature's matched bytes must stay inside
 * to be WEAK. Anything outside it (control bytes, DEL, any byte >= 0x80)
 * makes the signature STRONG — see the module header. */
const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX = 0x7e;

function isPrintableAsciiByte(b: number): boolean {
  return b >= PRINTABLE_ASCII_MIN && b <= PRINTABLE_ASCII_MAX;
}

/** STRONG iff at least one of the bytes a signature actually matched on
 * falls outside printable ASCII. Derived from the real matched bytes every
 * time — never a hand-set flag on the table entry. */
function isStrongMatch(matchedBytes: readonly number[]): boolean {
  return matchedBytes.some((b) => !isPrintableAsciiByte(b));
}

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

function asciiBytes(text: string): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
  return out;
}

/** Matches `expected` at `offset`, returning the matched bytes (so the
 * caller can derive strength from them) or null. */
function matchBytesAt(
  data: Uint8Array,
  offset: number,
  expected: readonly number[]
): readonly number[] | null {
  return bytesEqual(data, offset, expected) ? expected : null;
}

/** Matches an ASCII literal at `offset`, returning its bytes or null. */
function matchAsciiAt(data: Uint8Array, offset: number, text: string): readonly number[] | null {
  return asciiAt(data, offset, text) ? asciiBytes(text) : null;
}

/** Combines two matches into one (both must succeed), concatenating their
 * bytes for strength derivation. Null if either fails. */
function matchBoth(
  a: readonly number[] | null,
  b: readonly number[] | null
): readonly number[] | null {
  if (a === null || b === null) return null;
  return [...a, ...b];
}

/** The 4-byte brand of an ISO-base-media `ftyp` box (MP4, MOV, AVIF, HEIC, …)
 * — bytes 4-7 are literally 'ftyp', bytes 8-11 are the brand. Box size
 * (bytes 0-3) is never checked, so it plays no part in strength either.
 * `allowedBrands` narrows which brand(s) count as a match; omit it to match
 * any brand at all (the generic mp4/mov fallback). */
function matchFtyp(data: Uint8Array, allowedBrands?: readonly string[]): readonly number[] | null {
  const ftypBytes = matchAsciiAt(data, 4, 'ftyp');
  if (ftypBytes === null) return null;
  if (data.length < 12) return null;
  const brandBytes = Array.from(data.subarray(8, 12));
  if (allowedBrands !== undefined) {
    const brandLabel = String.fromCharCode(...brandBytes);
    if (!allowedBrands.includes(brandLabel)) return null;
  }
  return [...ftypBytes, ...brandBytes];
}

const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b, 0x03, 0x04];

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

/** Matches the zip signature, optionally narrowed to a first-entry-name
 * prefix (for OOXML sniffing). The matched bytes are always just the 4
 * zip-signature bytes — 0x03/0x04 are control bytes, so this is STRONG
 * regardless of the entry name. The entry name only narrows WHICH media
 * type is reported, never whether the match counts as binary. */
function matchZip(data: Uint8Array, entryPrefix?: string): readonly number[] | null {
  const sig = matchBytesAt(data, 0, ZIP_SIGNATURE);
  if (sig === null) return null;
  if (entryPrefix !== undefined && !(zipFirstEntryName(data) ?? '').startsWith(entryPrefix)) {
    return null;
  }
  return sig;
}

/** The mp3 frame-sync pattern: 0xFF followed by a byte with its top 3 bits
 * set (the MPEG sync word). Both bytes are always outside printable ASCII,
 * so this is always STRONG — unlike the plain-ASCII `ID3` tag signature,
 * which is WEAK. */
function matchMp3FrameSync(data: Uint8Array): readonly number[] | null {
  if (data.length < 2) return null;
  if (data[0] !== 0xff) return null;
  if ((data[1] & 0xe0) !== 0xe0) return null;
  return [data[0], data[1]];
}

interface Signature {
  readonly mediaType: string;
  /** Returns the EXACT bytes this signature inspected to decide it
   * matched, or null if it didn't match. Strength is derived from these
   * returned bytes by `isStrongMatch`, never set by hand on the entry. */
  readonly match: (data: Uint8Array) => readonly number[] | null;
}

const SIGNATURES: readonly Signature[] = [
  // Images the model can view.
  {
    mediaType: 'image/png',
    match: (d) => matchBytesAt(d, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mediaType: 'image/jpeg', match: (d) => matchBytesAt(d, 0, [0xff, 0xd8, 0xff]) },
  { mediaType: 'image/gif', match: (d) => matchAsciiAt(d, 0, 'GIF8') }, // GIF87a or GIF89a
  {
    mediaType: 'image/webp',
    match: (d) => matchBoth(matchAsciiAt(d, 0, 'RIFF'), matchAsciiAt(d, 8, 'WEBP')),
  },
  // Other images.
  { mediaType: 'image/bmp', match: (d) => matchAsciiAt(d, 0, 'BM') },
  {
    mediaType: 'image/tiff',
    match: (d) => matchAsciiAt(d, 0, 'II*\0') ?? matchAsciiAt(d, 0, 'MM\0*'),
  },
  { mediaType: 'image/x-icon', match: (d) => matchBytesAt(d, 0, [0x00, 0x00, 0x01, 0x00]) },
  { mediaType: 'image/avif', match: (d) => matchFtyp(d, ['avif']) },
  { mediaType: 'image/heic', match: (d) => matchFtyp(d, ['heic', 'heix', 'mif1']) },
  // Documents.
  { mediaType: 'application/pdf', match: (d) => matchAsciiAt(d, 0, '%PDF-') },
  // ZIP-based: OOXML first (narrower), generic zip last (the catch-all).
  {
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    match: (d) => matchZip(d, 'word/'),
  },
  {
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    match: (d) => matchZip(d, 'xl/'),
  },
  {
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    match: (d) => matchZip(d, 'ppt/'),
  },
  { mediaType: 'application/zip', match: (d) => matchZip(d) },
  // Archives.
  { mediaType: 'application/gzip', match: (d) => matchBytesAt(d, 0, [0x1f, 0x8b]) },
  {
    mediaType: 'application/x-7z-compressed',
    match: (d) => matchBytesAt(d, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  },
  { mediaType: 'application/x-tar', match: (d) => matchAsciiAt(d, 257, 'ustar') },
  // Media.
  { mediaType: 'audio/mpeg', match: (d) => matchAsciiAt(d, 0, 'ID3') },
  { mediaType: 'audio/mpeg', match: matchMp3FrameSync },
  {
    mediaType: 'audio/wav',
    match: (d) => matchBoth(matchAsciiAt(d, 0, 'RIFF'), matchAsciiAt(d, 8, 'WAVE')),
  },
  { mediaType: 'audio/ogg', match: (d) => matchAsciiAt(d, 0, 'OggS') },
  { mediaType: 'audio/flac', match: (d) => matchAsciiAt(d, 0, 'fLaC') },
  { mediaType: 'video/quicktime', match: (d) => matchFtyp(d, ['qt  ']) },
  { mediaType: 'video/mp4', match: (d) => matchFtyp(d) },
  // Fonts.
  { mediaType: 'font/woff', match: (d) => matchAsciiAt(d, 0, 'wOFF') },
  { mediaType: 'font/woff2', match: (d) => matchAsciiAt(d, 0, 'wOF2') },
  { mediaType: 'font/ttf', match: (d) => matchBytesAt(d, 0, [0x00, 0x01, 0x00, 0x00]) },
  { mediaType: 'font/otf', match: (d) => matchAsciiAt(d, 0, 'OTTO') },
  // Other.
  { mediaType: 'application/vnd.sqlite3', match: (d) => matchAsciiAt(d, 0, 'SQLite format 3\0') },
  { mediaType: 'application/wasm', match: (d) => matchBytesAt(d, 0, [0x00, 0x61, 0x73, 0x6d]) },
  { mediaType: 'application/x-elf', match: (d) => matchBytesAt(d, 0, [0x7f, 0x45, 0x4c, 0x46]) },
  {
    mediaType: 'application/x-mach-binary',
    match: (d) =>
      matchBytesAt(d, 0, [0xfe, 0xed, 0xfa, 0xce]) ??
      matchBytesAt(d, 0, [0xfe, 0xed, 0xfa, 0xcf]) ??
      matchBytesAt(d, 0, [0xce, 0xfa, 0xed, 0xfe]) ??
      matchBytesAt(d, 0, [0xcf, 0xfa, 0xed, 0xfe]),
  },
  { mediaType: 'application/x-msdownload', match: (d) => matchAsciiAt(d, 0, 'MZ') },
];

/** Scans the signature table once. Returns the first STRONG match (if any
 * — callers return it immediately) and the first WEAK match (if any —
 * callers consult it only if the text floor later fails). Table order is
 * the precedence order for both: a STRONG match found later in the table
 * still overrides an earlier WEAK one (there is no realistic collision
 * where this matters today, but a strong signal is conceptually certain
 * and a weak one is only a hint). */
function matchSignatures(data: Uint8Array): {
  readonly strong: string | null;
  readonly weak: string | null;
} {
  let weak: string | null = null;
  for (const sig of SIGNATURES) {
    const matchedBytes = sig.match(data);
    if (matchedBytes === null) continue;
    if (isStrongMatch(matchedBytes)) {
      return { strong: sig.mediaType, weak };
    }
    if (weak === null) weak = sig.mediaType;
  }
  return { strong: null, weak };
}

const UTF16_BOM_LE: readonly number[] = [0xff, 0xfe];
const UTF16_BOM_BE: readonly number[] = [0xfe, 0xff];

/** Classify raw bytes as a recognised binary format or as text. Never
 * throws. See the module header for the order, and for the STRONG/WEAK
 * signature rule.
 *
 * The UTF-16 BOM check runs FIRST, ahead of every signature — not just
 * ahead of the NUL heuristic. Found by testing, not by inspection: the mp3
 * frame-sync heuristic (`0xFF` followed by a byte with its top 3 bits set)
 * also matches `0xFF 0xFE`, the UTF-16LE BOM, since `0xFE`'s top 3 bits are
 * set too. A UTF-16-BOM'd file is text per this module's own stated
 * priority, so that check has to win the collision outright, not merely
 * win against the one heuristic it happened to be tested against. */
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

  const { strong, weak } = matchSignatures(data);
  if (strong !== null) {
    return { kind: 'binary', mediaType: strong };
  }

  const scanLen = Math.min(data.length, NUL_SCAN_WINDOW);
  let hasNul = false;
  for (let i = 0; i < scanLen; i++) {
    if (data[i] === 0) {
      hasNul = true;
      break;
    }
  }

  if (!hasNul) {
    // Strict UTF-8: a leading BOM is stripped by this decoder automatically
    // (ignoreBOM defaults to false); anything that does not decode cleanly
    // throws here instead of being silently replaced with U+FFFD.
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
      return { kind: 'text', content };
    } catch {
      // Falls through to the binary return below — a WEAK signature match
      // (if any) wins over the generic fallback at this point, since the
      // text floor has now also failed.
    }
  }

  return { kind: 'binary', mediaType: weak ?? 'application/octet-stream' };
}
