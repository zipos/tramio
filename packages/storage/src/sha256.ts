// Incremental SHA-256 (pure JS) for cross-platform file hashing on device.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export class Sha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: digest after finalize');
    let pos = 0;
    this.bytesHashed += data.length;
    while (pos < data.length) {
      const take = Math.min(64 - this.bufferLength, data.length - pos);
      this.buffer.set(data.subarray(pos, pos + take), this.bufferLength);
      this.bufferLength += take;
      pos += take;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  }

  finalize(): Uint8Array {
    if (this.finished) {
      throw new Error('Sha256: already finalized');
    }
    this.finished = true;
    this.buffer[this.bufferLength++] = 0x80;
    if (this.bufferLength > 56) {
      while (this.bufferLength < 64) this.buffer[this.bufferLength++] = 0;
      this.compress(this.buffer);
      this.bufferLength = 0;
    }
    while (this.bufferLength < 56) this.buffer[this.bufferLength++] = 0;
    const bitLenHi = Math.floor(this.bytesHashed / 0x20000000);
    const bitLenLo = (this.bytesHashed << 3) >>> 0;
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, bitLenHi, false);
    view.setUint32(60, bitLenLo, false);
    this.compress(this.buffer);
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, this.h0, false);
    dv.setUint32(4, this.h1, false);
    dv.setUint32(8, this.h2, false);
    dv.setUint32(12, this.h3, false);
    dv.setUint32(16, this.h4, false);
    dv.setUint32(20, this.h5, false);
    dv.setUint32(24, this.h6, false);
    dv.setUint32(28, this.h7, false);
    return out;
  }

  finalizeHex(): string {
    return bytesToHex(this.finalize());
  }

  private compress(chunk: Uint8Array): void {
    const w = new Uint32Array(64);
    const view = new DataView(chunk.buffer, chunk.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const wim15 = w[i - 15]!;
      const wim2 = w[i - 2]!;
      const wim7 = w[i - 7]!;
      const wim16 = w[i - 16]!;
      const s0 = rotr(wim15, 7) ^ rotr(wim15, 18) ^ (wim15 >>> 3);
      const s1 = rotr(wim2, 17) ^ rotr(wim2, 19) ^ (wim2 >>> 10);
      w[i] = (wim16 + s0 + wim7 + s1) >>> 0;
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;
    for (let i = 0; i < 64; i++) {
      const wi = w[i]!;
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + wi) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sha256HexFromIterable(chunks: AsyncIterable<Uint8Array>): Promise<{
  bytesWritten: number;
  sha256Hex: string;
}> {
  const hash = new Sha256();
  let bytesWritten = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    bytesWritten += chunk.length;
  }
  return { bytesWritten, sha256Hex: hash.finalizeHex() };
}
