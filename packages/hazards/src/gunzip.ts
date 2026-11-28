/**
 * Pure-JS RFC 1952 (GZIP) + RFC 1951 (DEFLATE) decoder.
 * Needed because React Native / OkHttp does not auto-decompress `.geojson.gz` responses served without a
 * `Content-Encoding: gzip` header (such as Régie essence Québec's `stations.geojson.gz`).
 */

const FIXED_LIT = new Uint8Array(288);
for (let i = 0; i <= 143; i++) FIXED_LIT[i] = 8;
for (let i = 144; i <= 255; i++) FIXED_LIT[i] = 9;
for (let i = 256; i <= 279; i++) FIXED_LIT[i] = 7;
for (let i = 280; i <= 287; i++) FIXED_LIT[i] = 8;

const FIXED_DIST = new Uint8Array(32).fill(5);

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

interface HuffTree {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildTree(lengths: Uint8Array, count = lengths.length): HuffTree {
  const counts = new Uint16Array(16);
  for (let i = 0; i < count; i++) {
    const l = lengths[i]!;
    if (l > 0) counts[l] = (counts[l] ?? 0) + 1;
  }
  const offsets = new Uint16Array(16);
  let total = 0;
  for (let bits = 1; bits <= 15; bits++) {
    offsets[bits] = total;
    total += counts[bits]!;
  }
  const symbols = new Uint16Array(total);
  for (let i = 0; i < count; i++) {
    const l = lengths[i]!;
    if (l > 0) {
      symbols[offsets[l]!] = i;
      offsets[l] = (offsets[l] ?? 0) + 1;
    }
  }
  return { counts, symbols };
}

const FIXED_LIT_TREE = buildTree(FIXED_LIT);
const FIXED_DIST_TREE = buildTree(FIXED_DIST);

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8;
}

/** Synchronous pure-JS gunzip (RFC 1952 + RFC 1951). */
export function gunzipBytes(src: Uint8Array): Uint8Array {
  if (!isGzip(src)) return src;
  const flg = src[3]!;
  let pos = 10;
  if (flg & 4) {
    const xlen = src[pos]! | (src[pos + 1]! << 8);
    pos += 2 + xlen;
  }
  if (flg & 8) {
    while (pos < src.length && src[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 16) {
    while (pos < src.length && src[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 2) pos += 2;

  const isize = (src[src.length - 4]! | (src[src.length - 3]! << 8) | (src[src.length - 2]! << 16) | (src[src.length - 1]! << 24)) >>> 0;
  let out = new Uint8Array(Math.min(Math.max(isize || 65536, 4096), 32 * 1024 * 1024));
  let outLen = 0;
  const ensure = (more: number) => {
    if (outLen + more <= out.length) return;
    let next = out.length * 2;
    while (next < outLen + more) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(out.subarray(0, outLen));
    out = grown;
  };

  let bitBuf = 0;
  let bitCnt = 0;
  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('truncated gzip stream');
      bitBuf |= src[pos++]! << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };

  const decodeSym = (t: HuffTree): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = t.counts[len]!;
      if (code - c < first) return t.symbols[index + (code - first)]!;
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('invalid deflate huffman code');
  };

  let bfinal = 0;
  while (bfinal === 0) {
    bfinal = bits(1);
    const btype = bits(2);
    if (btype === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('truncated stored block');
      const len = src[pos]! | (src[pos + 1]! << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error('truncated stored payload');
      ensure(len);
      out.set(src.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      continue;
    }
    if (btype === 3) throw new Error('invalid deflate block type');
    let litTree = FIXED_LIT_TREE;
    let distTree = FIXED_DIST_TREE;
    if (btype === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const clens = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]!] = bits(3);
      const cTree = buildTree(clens, 19);
      const lens = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const s = decodeSym(cTree);
        if (s < 16) {
          lens[i++] = s;
        } else if (s === 16) {
          const prev = i > 0 ? lens[i - 1]! : 0;
          let rep = bits(2) + 3;
          while (rep-- > 0) lens[i++] = prev;
        } else if (s === 17) {
          let rep = bits(3) + 3;
          while (rep-- > 0) lens[i++] = 0;
        } else {
          let rep = bits(7) + 11;
          while (rep-- > 0) lens[i++] = 0;
        }
      }
      litTree = buildTree(lens.subarray(0, hlit), hlit);
      distTree = buildTree(lens.subarray(hlit, hlit + hdist), hdist);
    }

    for (;;) {
      const sym = decodeSym(litTree);
      if (sym === 256) break;
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else {
        const li = sym - 257;
        const length = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
        const di = decodeSym(distTree);
        const dist = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
        if (dist > outLen) throw new Error('invalid deflate back-reference');
        ensure(length);
        let srcIdx = outLen - dist;
        for (let k = 0; k < length; k++) out[outLen++] = out[srcIdx++]!;
      }
    }
  }
  return out.subarray(0, outLen);
}

const utf8Dec = new TextDecoder();

/** Decodes a response body that may be raw UTF-8 text or raw `.gz` gzipped UTF-8 bytes. */
export function decodeBodyText(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return utf8Dec.decode(isGzip(bytes) ? gunzipBytes(bytes) : bytes);
}
