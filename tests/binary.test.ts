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

describe('classifyFileContent — signatures', () => {
  it('detects a PNG from its 8-byte signature', () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    expect(asBinary(classifyFileContent(png)).mediaType).toBe('image/png');
  });

  it('detects a JPEG from its 3-byte signature', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(asBinary(classifyFileContent(jpeg)).mediaType).toBe('image/jpeg');
  });

  it('detects a GIF (GIF89a) from its signature', () => {
    const gif = Buffer.from('GIF89a\x00\x00', 'latin1');
    expect(asBinary(classifyFileContent(gif)).mediaType).toBe('image/gif');
  });

  it('detects a PDF from its %PDF- signature', () => {
    const pdf = Buffer.from('%PDF-1.4\n%...', 'latin1');
    expect(asBinary(classifyFileContent(pdf)).mediaType).toBe('application/pdf');
  });

  it('detects WEBP and WAV as DISTINCT RIFF-based formats, the regression this round fixes', () => {
    // Before this change, WAV had no signature of its own: it fell through
    // to the NUL-byte scan, which matched the RIFF chunk-size field's
    // all-zero bytes and wrongly reported application/octet-stream.
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP', 'latin1'),
    ]);
    expect(asBinary(classifyFileContent(webp)).mediaType).toBe('image/webp');

    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1'),
    ]);
    expect(asBinary(classifyFileContent(wav)).mediaType).toBe('audio/wav');
  });

  it('reads a ftyp box brand to distinguish AVIF/HEIC from plain MP4/MOV', () => {
    const ftypBox = (brand: string) =>
      Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from('ftyp', 'latin1'),
        Buffer.from(brand, 'latin1'),
      ]);
    expect(asBinary(classifyFileContent(ftypBox('isom'))).mediaType).toBe('video/mp4');
    expect(asBinary(classifyFileContent(ftypBox('avif'))).mediaType).toBe('image/avif');
    expect(asBinary(classifyFileContent(ftypBox('heic'))).mediaType).toBe('image/heic');
  });

  it('sniffs OOXML (docx) from the first entry name in a ZIP; an inconclusive first entry stays application/zip', () => {
    function zipWithFirstEntry(name: string): Buffer {
      const nameBytes = Buffer.from(name, 'latin1');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(nameBytes.length, 26);
      return Buffer.concat([header, nameBytes]);
    }
    expect(asBinary(classifyFileContent(zipWithFirstEntry('[Content_Types].xml'))).mediaType).toBe(
      'application/zip'
    );
    expect(asBinary(classifyFileContent(zipWithFirstEntry('word/document.xml'))).mediaType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
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
});

describe('classifyFileContent — text, including what must NOT be sniffed as binary', () => {
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

  it('invalid UTF-8 (no signature, no NUL) is reported as binary application/octet-stream, not a lossy decode', () => {
    // 0xFF is never a valid UTF-8 leading byte -- fatal:true rejects it.
    const invalid = Buffer.from([0x41, 0x42, 0xff, 0x43]);
    expect(asBinary(classifyFileContent(invalid)).mediaType).toBe('application/octet-stream');
  });

  it('treats empty content as text', () => {
    expect(asText(classifyFileContent(Buffer.alloc(0))).content).toBe('');
  });
});
