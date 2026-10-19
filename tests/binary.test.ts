import { describe, it, expect } from 'vitest';
import { classifyFileContent, type ClassifiedContent } from '../src/binary.js';

function asBinary(result: ClassifiedContent): { mediaType: string } {
  if (result.kind !== 'binary') throw new Error(`expected binary, got kind ${result.kind}`);
  return result;
}
function asText(result: ClassifiedContent): { content: string } {
  if (result.kind !== 'text') throw new Error(`expected text, got kind ${result.kind}`);
  return result;
}

function zipWithFirstEntry(name: string): Buffer {
  const nameBytes = Buffer.from(name, 'latin1');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([header, nameBytes]);
}

// ---------------------------------------------------------------------------
// One minimal fixture per signature table entry, each with the padding a
// REAL file of that format would actually have (NUL-heavy size/version
// fields, a genuine ID3 header, a genuine zip local-file header, ...). The
// WEAK entries below rely on that real padding to classify as binary, same
// as a real file would — none of them is hand-exempted from the text floor.
// ---------------------------------------------------------------------------
const SIGNATURE_FIXTURES: ReadonlyArray<[string, Buffer, string]> = [
  [
    'png',
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    'image/png',
  ],
  ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), 'image/jpeg'],
  ['gif', Buffer.from('GIF89a\x00\x00', 'latin1'), 'image/gif'],
  [
    'webp',
    Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'latin1'),
    ]),
    'image/webp',
  ],
  [
    'bmp',
    Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.from([0x36, 0, 0, 0, 0, 0, 0, 0])]),
    'image/bmp',
  ],
  ['tiff (little-endian)', Buffer.from('II*\x00extra', 'latin1'), 'image/tiff'],
  ['ico', Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), 'image/x-icon'],
  [
    'avif',
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif', 'latin1')]),
    'image/avif',
  ],
  [
    'heic',
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1')]),
    'image/heic',
  ],
  [
    'pdf',
    Buffer.concat([
      Buffer.from('%PDF-1.4\n%', 'latin1'),
      Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]),
      Buffer.from('\n', 'latin1'),
    ]),
    'application/pdf',
  ],
  [
    'ooxml docx',
    zipWithFirstEntry('word/document.xml'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  [
    'ooxml xlsx',
    zipWithFirstEntry('xl/workbook.xml'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  [
    'ooxml pptx',
    zipWithFirstEntry('ppt/presentation.xml'),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  ['zip (inconclusive first entry)', zipWithFirstEntry('[Content_Types].xml'), 'application/zip'],
  ['gzip', Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]), 'application/gzip'],
  [
    '7z',
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
    'application/x-7z-compressed',
  ],
  [
    'tar',
    Buffer.concat([Buffer.alloc(257, 0x00), Buffer.from('ustar\x00', 'latin1')]),
    'application/x-tar',
  ],
  [
    'mp3 (ID3 tag)',
    Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00]),
    ]),
    'audio/mpeg',
  ],
  ['mp3 (frame sync)', Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00]), 'audio/mpeg'],
  [
    'wav',
    Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WAVE', 'latin1'),
    ]),
    'audio/wav',
  ],
  [
    'ogg',
    Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.from([0x00, 0x02, 0, 0, 0, 0, 0, 0])]),
    'audio/ogg',
  ],
  [
    'flac',
    Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.from([0x00, 0x00, 0x22])]),
    'audio/flac',
  ],
  [
    'quicktime',
    Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ', 'latin1')]),
    'video/quicktime',
  ],
  [
    'mp4 (generic ftyp)',
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1')]),
    'video/mp4',
  ],
  [
    'woff',
    Buffer.concat([Buffer.from('wOFF', 'latin1'), Buffer.from([0x00, 0x01, 0x00, 0x00])]),
    'font/woff',
  ],
  [
    'woff2',
    Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.from([0x00, 0x01, 0x00, 0x00])]),
    'font/woff2',
  ],
  ['ttf', Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0a]), 'font/ttf'],
  ['otf', Buffer.concat([Buffer.from('OTTO', 'latin1'), Buffer.from([0x00, 0x0a])]), 'font/otf'],
  ['sqlite', Buffer.from('SQLite format 3\x00extra', 'latin1'), 'application/vnd.sqlite3'],
  ['wasm', Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), 'application/wasm'],
  ['elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), 'application/x-elf'],
  [
    'mach-o',
    Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0x00, 0x00, 0x00, 0x07]),
    'application/x-mach-binary',
  ],
  [
    'pe/msdownload',
    Buffer.concat([
      Buffer.from('MZ', 'latin1'),
      Buffer.from([0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]),
    ]),
    'application/x-msdownload',
  ],
];

describe('classifyFileContent — signature table (one realistic fixture per entry)', () => {
  it.each(SIGNATURE_FIXTURES)('%s -> %s', (_label, bytes, expectedMediaType) => {
    expect(asBinary(classifyFileContent(bytes)).mediaType).toBe(expectedMediaType);
  });
});

describe('classifyFileContent — signature ordering', () => {
  it('a QuickTime brand (ftyp qt  ) is reported as video/quicktime, not the generic video/mp4 that would also match any ftyp box', () => {
    const qt = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ', 'latin1')]);
    expect(asBinary(classifyFileContent(qt)).mediaType).toBe('video/quicktime');
  });

  it('an ordinary ftyp brand (isom) falls through to the generic video/mp4', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1')]);
    expect(asBinary(classifyFileContent(mp4)).mediaType).toBe('video/mp4');
  });
});

// ---------------------------------------------------------------------------
// Every WEAK entry (printable-ASCII-only signature bytes) gets a text case:
// ordinary English or ordinary container text that happens to start with
// that signature's magic bytes, with no NUL and no invalid UTF-8 anywhere
// in the content, so the text floor holds and the content reads back
// exactly as written.
// ---------------------------------------------------------------------------
describe('classifyFileContent — WEAK signatures: ordinary text, not misclassified as binary', () => {
  const WEAK_TEXT_CASES: ReadonlyArray<[string, string]> = [
    ['bmp ("BM")', 'BMW notes on the quarterly report.\n'],
    ['pe/msdownload ("MZ")', 'MZ, can you take a look at this PR?\n'],
    ['mp3 ID3 tag ("ID3")', 'ID3 tags are a mess to parse by hand.\n'],
    ['otf ("OTTO")', "OTTO's font metrics look wrong on this glyph.\n"],
    ['pdf ("%PDF-")', '%PDF- is not a whole file, just a string that starts this way.\n'],
    ['gif ("GIF89a")', 'GIF89a is the animated variant of the GIF89a image format.\n'],
    ['ogg ("OggS")', 'OggS is the four-byte Ogg container capture pattern.\n'],
    ['flac ("fLaC")', 'fLaC is a lossless audio codec used by several players.\n'],
    ['woff ("wOFF")', 'wOFF is a font format used widely on the web.\n'],
    ['woff2 ("wOF2")', 'wOF2 is the second-generation WOFF compression scheme.\n'],
    ['webp (RIFF....WEBP)', 'RIFF1234WEBP is apparently also a real word collision.\n'],
    ['wav (RIFF....WAVE)', 'RIFF1234WAVE is a sound format reference only, not a file.\n'],
    ['avif (ftyp avif)', 'SIZEftypavif gets mentioned a lot in image tooling docs.\n'],
    ['heic (ftyp heic)', 'SIZEftypheic photos come from recent iPhones by default.\n'],
    ['quicktime (ftyp qt  )', 'SIZEftypqt  describes an old QuickTime movie format.\n'],
    ['mp4 generic (ftyp isom)', 'SIZEftypisom is the base media file format brand name.\n'],
    [
      'tar ("ustar" at offset 257)',
      'A'.repeat(257) + 'ustar is a common tar archive header magic string.\n',
    ],
  ];

  it.each(WEAK_TEXT_CASES)('%s reads as text, unchanged', (_label, text) => {
    expect(asText(classifyFileContent(Buffer.from(text, 'utf8'))).content).toBe(text);
  });
});

describe('classifyFileContent — the text floor, and what must never be sniffed as binary', () => {
  it('treats plain ASCII text as text', () => {
    expect(asText(classifyFileContent(Buffer.from('hello world\n', 'utf8'))).content).toBe(
      'hello world\n'
    );
  });

  it('treats non-ASCII UTF-8 text as text, byte-for-byte unchanged', () => {
    const text = 'héllo wörld — 日本語\n';
    expect(asText(classifyFileContent(Buffer.from(text, 'utf8'))).content).toBe(text);
  });

  it('strips a UTF-8 BOM and returns text, as before this change', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    expect(asText(classifyFileContent(withBom)).content).toBe('hello');
  });

  it('decodes UTF-16LE with a BOM as text, even though it is full of NUL bytes', () => {
    const text = 'hello';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(asText(classifyFileContent(utf16)).content).toBe(text);
  });

  it('decodes UTF-16BE with a BOM as text', () => {
    const text = 'hi';
    const le = Buffer.from(text, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    expect(asText(classifyFileContent(utf16be)).content).toBe(text);
  });

  it('an SVG (plain XML text) is read as text, never sniffed as an image', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
    expect(asText(classifyFileContent(Buffer.from(svg, 'utf8'))).content).toBe(svg);
  });

  it('detects application/octet-stream from a NUL byte in the first 8 KiB, for content matching no known signature', () => {
    const data = Buffer.concat([
      Buffer.from('some header text'),
      Buffer.from([0x00]),
      Buffer.from('more bytes'),
    ]);
    expect(asBinary(classifyFileContent(data)).mediaType).toBe('application/octet-stream');
  });

  it('does NOT flag a NUL byte past the first 8 KiB, the stated floor of this check, and reads it as text', () => {
    const data = Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]);
    expect(classifyFileContent(data).kind).toBe('text');
  });

  it('invalid UTF-8 (no signature, no NUL) is reported as binary application/octet-stream, not a lossy decode', () => {
    // 0xFF is never a valid UTF-8 leading byte -- fatal:true rejects it.
    const invalid = Buffer.from([0x41, 0x42, 0xff, 0x43]);
    expect(asBinary(classifyFileContent(invalid)).mediaType).toBe('application/octet-stream');
  });

  it('treats empty content as text', () => {
    expect(asText(classifyFileContent(Buffer.alloc(0))).content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Untested guards inside the signature matchers themselves (matchFtyp,
// zipFirstEntryName, matchMp3FrameSync) -- each asserts the REAL
// fall-through classifyFileContent actually produces, not an assumption
// about what it should produce.
// ---------------------------------------------------------------------------
describe('classifyFileContent — matchFtyp: an ftyp match too short to carry a brand', () => {
  it('an ftyp box with "ftyp" present but fewer than 12 bytes total never matches avif/heic/quicktime/mp4, and falls through to the generic binary floor', () => {
    // Bytes 4-7 are literally 'ftyp' (what matchAsciiAt checks), but the
    // buffer is only 8 bytes long -- too short for the brand at bytes 8-11 --
    // so matchFtyp's own `data.length < 12` guard must reject this for every
    // brand, including the brand-less generic mp4 matcher.
    const tooShort = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x14]),
      Buffer.from('ftyp', 'latin1'),
    ]);
    expect(tooShort.length).toBe(8);
    expect(asBinary(classifyFileContent(tooShort)).mediaType).toBe('application/octet-stream');
  });
});

describe('classifyFileContent — zipFirstEntryName: guards against reading past a short buffer', () => {
  it('a zip signature with fewer than 30 bytes total (no room for the fixed local-file header) falls through to generic application/zip, never OOXML', () => {
    const tooShortForHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // just the 4-byte signature
    expect(asBinary(classifyFileContent(tooShortForHeader)).mediaType).toBe('application/zip');
  });

  it('nameLen === 0 in an otherwise-complete 30-byte header falls through to generic application/zip', () => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0, 26); // nameLen = 0
    expect(asBinary(classifyFileContent(header)).mediaType).toBe('application/zip');
  });

  it('a promised entry-name length with NO name bytes at all (data.length < 30 + nameLen) falls through to generic application/zip', () => {
    const header = Buffer.alloc(30); // exactly the fixed header, no name bytes follow
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(5, 26); // nameLen = 5, but nothing after byte 30
    expect(asBinary(classifyFileContent(header)).mediaType).toBe('application/zip');
  });

  it('a zip truncated partway through its own promised entry name (some, but not all, name bytes present) falls through to generic application/zip', () => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(10, 26); // nameLen = 10
    const partialName = Buffer.from('wo', 'latin1'); // only 2 of the promised 10 bytes
    const truncated = Buffer.concat([header, partialName]);
    expect(asBinary(classifyFileContent(truncated)).mediaType).toBe('application/zip');
  });
});

describe('classifyFileContent — matchMp3FrameSync: rejects a leading 0xFF that is not a real frame-sync byte', () => {
  it('0xFF followed by a byte without the top 3 (0xE0) bits set is not an mp3 frame sync, and falls through to the generic binary floor', () => {
    // 0x00 & 0xE0 === 0, not 0xE0, so matchMp3FrameSync's own bit check must
    // reject this pair -- a real frame-sync second byte needs 0xE0-0xFF. The
    // same 0x00 byte also puts this on the NUL floor, so the fall-through is
    // deterministic rather than resting on UTF-8 validity.
    const notAFrameSync = Buffer.from([0xff, 0x00, 0x00]);
    expect((0x00 & 0xe0) === 0xe0).toBe(false); // documents exactly which check this exercises
    expect(asBinary(classifyFileContent(notAFrameSync)).mediaType).toBe('application/octet-stream');
  });
});
