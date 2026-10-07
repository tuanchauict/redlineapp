// SHA-1 and SHA-256, in plain JavaScript.
//
// node:crypto does both of these and is faster at it, but these two hashes are
// *names*: a snapshot is stored under its SHA-256, a document's index file is
// named after the SHA-1 of its path, and a checked-off change is remembered by
// the hash of its own words. Every one of those is already written down in
// ~/.redline on somebody's disk, so the digests cannot move by a byte.
//
// They are here rather than in store.js because the diff needs one of them and
// nothing else node:crypto offers. Reaching for it dragged node:fs in behind
// it, and the diff has to run in a webview where there is no such thing. The
// WebCrypto that a browser does have is async, and `keyFor` hashes in the
// middle of laying out a block, so it was never a candidate.
//
// Both are checked against node:crypto over a corpus, including the multi-byte
// and block-boundary cases that are the only places an implementation like this
// tends to go wrong.

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

const utf8 = (text) =>
  typeof TextEncoder === 'undefined'
    ? new Uint8Array(Buffer.from(text, 'utf8'))
    : new TextEncoder().encode(text);

/**
 * Append the 1 bit, the zero padding and the 64-bit big-endian bit length that
 * both of these hashes agree on, and return a view for reading words back out.
 */
function padded(bytes) {
  const len = bytes.length;
  // Room for the 0x80 byte and the eight length bytes, rounded up to a block.
  const blocks = new Uint8Array((((len + 9 + 63) >> 6) << 6));
  blocks.set(bytes);
  blocks[len] = 0x80;
  const view = new DataView(blocks.buffer);
  // The length is in *bits*, and can exceed 2^32 for a document over 512 MB,
  // so it is written as two words rather than one.
  const bits = len * 8;
  view.setUint32(blocks.length - 8, Math.floor(bits / 4294967296));
  view.setUint32(blocks.length - 4, bits >>> 0);
  return { blocks, view };
}

const hex = (words) => words.map((w) => (w >>> 0).toString(16).padStart(8, '0')).join('');

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of a string, lowercase hex — `crypto.createHash('sha256')`. */
export function sha256Hex(text) {
  const { blocks, view } = padded(utf8(text));
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);

  for (let at = 0; at < blocks.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    const next = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) H[i] = (H[i] + next[i]) >>> 0;
  }

  return hex(H);
}

/** SHA-1 of a string, lowercase hex — `crypto.createHash('sha1')`. */
export function sha1Hex(text) {
  const { blocks, view } = padded(utf8(text));
  const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);

  for (let at = 0; at < blocks.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let [a, b, c, d, e] = H;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }

    const next = [a, b, c, d, e];
    for (let i = 0; i < 5; i++) H[i] = (H[i] + next[i]) >>> 0;
  }

  return hex(H);
}

/**
 * What names a version of a document. Sixteen hex digits of SHA-256: short
 * enough to read in a filename, long enough that two versions of one file
 * colliding is not a thing that happens.
 */
export function hashContent(text) {
  return sha256Hex(text).slice(0, 16);
}

/** What names a document's index file: the full SHA-1 of its absolute path. */
export function docKey(abs) {
  return sha1Hex(abs);
}

/** Bytes in a string once encoded, which is what a snapshot's `size` means. */
export function byteLength(text) {
  return utf8(text).length;
}
