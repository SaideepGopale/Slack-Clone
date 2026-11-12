/**
 * T.33 — upload content checks ("magic bytes").
 *
 * The multipart Content-Type is chosen by the client, so on its own it proves
 * nothing: an executable can be sent as image/png. Every upload's first bytes
 * must match the format its declared type names; text types must actually be
 * text; SVG (the one allowed format that can carry script) is read in full
 * and refused if it contains active content. Runs before a byte reaches
 * storage.
 */
export const SNIFF_BYTES = 4_100;
export const SVG_MAX_BYTES = 2 * 1024 * 1024;

const ascii = (head: Buffer, offset: number, text: string) => head.length >= offset + text.length && head.toString('latin1', offset, offset + text.length) === text;
const bytes = (head: Buffer, offset: number, values: number[]) => head.length >= offset + values.length && values.every((v, i) => head[offset + i] === v);

const isJpeg = (h: Buffer) => bytes(h, 0, [0xff, 0xd8, 0xff]);
const isPng = (h: Buffer) => bytes(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isGif = (h: Buffer) => ascii(h, 0, 'GIF87a') || ascii(h, 0, 'GIF89a');
const isWebp = (h: Buffer) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WEBP');
const isWav = (h: Buffer) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WAVE');
const isEbml = (h: Buffer) => bytes(h, 0, [0x1a, 0x45, 0xdf, 0xa3]); // WebM / Matroska
const isIsoMedia = (h: Buffer) => ascii(h, 4, 'ftyp'); // MP4, MOV, M4A
const isQuickTime = (h: Buffer) => isIsoMedia(h) || ['moov', 'mdat', 'wide', 'free', 'skip'].some((box) => ascii(h, 4, box));
const isOgg = (h: Buffer) => ascii(h, 0, 'OggS');
const isMp3 = (h: Buffer) => ascii(h, 0, 'ID3') || (h.length >= 2 && h[0] === 0xff && (h[1] & 0xe0) === 0xe0);
const isAac = (h: Buffer) => (h.length >= 2 && h[0] === 0xff && (h[1] & 0xf6) === 0xf0) || ascii(h, 0, 'ADIF') || isIsoMedia(h);
const isPdf = (h: Buffer) => ascii(h, 0, '%PDF-');
const isZip = (h: Buffer) => bytes(h, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(h, 0, [0x50, 0x4b, 0x05, 0x06]);
const isOle = (h: Buffer) => bytes(h, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy .doc/.xls/.ppt

const isExecutable = (h: Buffer) =>
  ascii(h, 0, 'MZ') || // Windows PE
  bytes(h, 0, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
  bytes(h, 0, [0xcf, 0xfa, 0xed, 0xfe]) || bytes(h, 0, [0xce, 0xfa, 0xed, 0xfe]) || bytes(h, 0, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O
  ascii(h, 0, '#!');

/** Text: no NUL bytes and valid UTF-8 (a multi-byte character may be cut at the end of the sample). */
const isText = (h: Buffer) => {
  if (h.includes(0)) return false;
  const sample = h.length >= SNIFF_BYTES ? h.subarray(0, h.length - 4) : h;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
};

const CHECKS: Record<string, (h: Buffer) => boolean> = {
  'image/jpeg': isJpeg,
  'image/png': isPng,
  'image/gif': isGif,
  'image/webp': isWebp,
  'video/mp4': isIsoMedia,
  'video/quicktime': isQuickTime,
  'video/webm': isEbml,
  'audio/webm': isEbml,
  'audio/ogg': isOgg,
  'audio/wav': isWav,
  'audio/mpeg': isMp3,
  'audio/mp3': isMp3,
  'audio/mp4': isIsoMedia,
  'audio/m4a': isIsoMedia,
  'audio/x-m4a': isIsoMedia,
  'audio/aac': isAac,
  'application/pdf': isPdf,
  'application/zip': isZip,
  'application/x-zip-compressed': isZip,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': isZip,
  'application/msword': isOle,
  'application/vnd.ms-excel': (h) => isOle(h) || isText(h), // some tools label CSV this way
  'application/vnd.ms-powerpoint': isOle,
  'text/plain': isText,
  'text/csv': isText,
  // The generic label: only documents/archives whose real format is allowed.
  'application/octet-stream': (h) => isZip(h) || isOle(h) || isPdf(h),
};

export const baseMimeType = (mimetype: string) => mimetype.split(';')[0].trim().toLowerCase();

/** null when the content matches the declared type, else a user-facing reason. */
export const contentMismatch = (mimetype: string, head: Buffer): string | null => {
  if (head.length === 0) return 'The file is empty.';
  if (isExecutable(head)) return 'Programs and scripts cannot be uploaded.';
  const base = baseMimeType(mimetype);
  if (base === 'image/svg+xml') return null; // checked in full by svgProblem()
  const check = CHECKS[base];
  if (!check) return 'This file type is not allowed.';
  return check(head) ? null : 'The file’s content does not match its type. Please upload the original file.';
};

/** SVGs are images that can run code; anything active is refused. */
export const svgProblem = (svg: Buffer): string | null => {
  if (svg.length === 0) return 'The file is empty.';
  if (!isText(svg.subarray(0, Math.min(svg.length, SNIFF_BYTES)))) return 'This SVG is not a valid text file.';
  const text = svg.toString('utf8').toLowerCase();
  if (!/<svg[\s>]/.test(text)) return 'This file is not an SVG image.';
  const active = [/<script/, /\son[a-z]+\s*=/, /javascript\s*:/, /<foreignobject/, /<iframe/, /<embed/, /<object/, /<!entity/, /<\?xml-stylesheet/, /data\s*:\s*text\/html/];
  if (active.some((pattern) => pattern.test(text))) return 'SVG images with scripts or embedded content are not allowed.';
  return null;
};
