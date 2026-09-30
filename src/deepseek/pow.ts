/**
 * deepseek/pow.ts — DeepSeek 上游的 HashV1 工作量证明（PoW）。
 *
 * 移植自 simple-chat `app/internal/pow/{pow.go,solver.go}`（MIT，Sliverkiss/simple-chat）。
 *
 * 协议事实（不变式，别「顺手优化」）：
 *  - HashV1 = SHA3-256 的**变体**：rate 136、域分隔 0x06、末字节 0x80，
 *    但 Keccak-f[1600] **跳过第 0 轮**（只跑 1..23）。因此它不是标准 SHA3-256，
 *    无法用 crypto.subtle 或任何现成 SHA3 实现替代。
 *  - 挑战应答要求 256 位**精确相等**：上游在 [0, difficulty) 内挑一个 nonce，
 *    返回 challenge = HashV1("<salt>_<expire_at>_<nonce>")。解题 = 顺序暴力枚举，
 *    平均 difficulty/2 次置换（实测 difficulty 默认 144000 ⇒ 平均约 72k 次）。
 *  - 应答头 x-ds-pow-response = base64(JSON{algorithm,challenge,salt,answer,signature,target_path})，
 *    **不含** difficulty / expire_at。
 *
 * 性能取向：64 位运算全部拆成 hi/lo 两个 32 位字（Uint32Array + Number 位运算），
 * 不用 BigInt——BigInt 在这个 14 万次/请求的热循环里慢一个数量级。
 * 前缀按 Go 版做法预吸收进 base 状态，热循环里每个 nonce 只吸收尾部一块。
 */

import { base64Encode, fromHex, utf8 } from './bytes'

/** Keccak 置换的 rate（SHA3-256），字节。 */
const RATE = 136
/** 一个 rate 块 = 17 个 64 位lane。 */
const LANES_PER_BLOCK = RATE / 8

// ===== 轮常量（跳过第 0 轮，故只用到 RC[1..23]），拆成 lo/hi =====
const RC_LO = Uint32Array.from([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
])
const RC_HI = Uint32Array.from([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
])

// ===== rho+pi：src lane → (dst lane, 左旋位数)，由 Go 版 b0..b24 赋值逐条转写 =====
const RHO_PI_DST = new Uint8Array([
  0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4,
])
const RHO_PI_ROT = new Uint8Array([
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
])

// theta 的列奇偶校验暂存（置换不可重入，模块级复用避免热循环里分配）
const C_LO = new Uint32Array(5)
const C_HI = new Uint32Array(5)

/**
 * keccakF23：对 (slo, shi) 表示的状态跑 Keccak-f[1600] 的**第 1..23 轮**。
 * (blo, bhi) 是调用方提供的 rho/pi 暂存区，避免每次置换分配。
 */
function keccakF23(
  slo: Uint32Array,
  shi: Uint32Array,
  blo: Uint32Array,
  bhi: Uint32Array,
): void {
  for (let r = 1; r < 24; r++) {
    // ---- theta ----
    for (let x = 0; x < 5; x++) {
      C_LO[x] = (slo[x] ^ slo[x + 5] ^ slo[x + 10] ^ slo[x + 15] ^ slo[x + 20]) >>> 0
      C_HI[x] = (shi[x] ^ shi[x + 5] ^ shi[x + 10] ^ shi[x + 15] ^ shi[x + 20]) >>> 0
    }
    for (let x = 0; x < 5; x++) {
      const n1 = x === 4 ? 0 : x + 1
      const n4 = x === 0 ? 4 : x - 1
      // d = C[n4] ^ rotl64(C[n1], 1)
      const dLo = (C_LO[n4] ^ (((C_LO[n1] << 1) | (C_HI[n1] >>> 31)) >>> 0)) >>> 0
      const dHi = (C_HI[n4] ^ (((C_HI[n1] << 1) | (C_LO[n1] >>> 31)) >>> 0)) >>> 0
      for (let j = x; j < 25; j += 5) {
        slo[j] = (slo[j] ^ dLo) >>> 0
        shi[j] = (shi[j] ^ dHi) >>> 0
      }
    }

    // ---- rho + pi ----
    for (let src = 0; src < 25; src++) {
      const dst = RHO_PI_DST[src]
      const k = RHO_PI_ROT[src]
      const lo = slo[src]
      const hi = shi[src]
      if (k === 0) {
        blo[dst] = lo
        bhi[dst] = hi
      } else if (k < 32) {
        blo[dst] = ((lo << k) | (hi >>> (32 - k))) >>> 0
        bhi[dst] = ((hi << k) | (lo >>> (32 - k))) >>> 0
      } else {
        const kk = k - 32
        blo[dst] = ((hi << kk) | (lo >>> (32 - kk))) >>> 0
        bhi[dst] = ((lo << kk) | (hi >>> (32 - kk))) >>> 0
      }
    }

    // ---- chi + iota ----
    for (let base = 0; base < 25; base += 5) {
      for (let j = 0; j < 5; j++) {
        const i = base + j
        const n1 = base + (j === 4 ? 0 : j + 1)
        const n2 = base + (j === 3 ? 0 : j === 4 ? 1 : j + 2)
        const aLo = (blo[i] ^ (~blo[n1] & blo[n2])) >>> 0
        const aHi = (bhi[i] ^ (~bhi[n1] & bhi[n2])) >>> 0
        if (i === 0) {
          slo[0] = (aLo ^ RC_LO[r]) >>> 0
          shi[0] = (aHi ^ RC_HI[r]) >>> 0
        } else {
          slo[i] = aLo
          shi[i] = aHi
        }
      }
    }
  }
}

/** 把一个 136 字节块按小端 XOR 吸收进状态。 */
function absorbBlock(
  slo: Uint32Array,
  shi: Uint32Array,
  bytes: Uint8Array,
  off: number,
): void {
  for (let i = 0; i < LANES_PER_BLOCK; i++) {
    const o = off + i * 8
    slo[i] =
      (slo[i] ^ (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24))) >>> 0
    shi[i] =
      (shi[i] ^
        (bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24))) >>>
      0
  }
}

/** 从状态挤出前 4 个 lane 的 32 字节（小端），即 HashV1 摘要。 */
function squeeze32(slo: Uint32Array, shi: Uint32Array): Uint8Array {
  const out = new Uint8Array(32)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) {
    dv.setUint32(i * 8, slo[i], true)
    dv.setUint32(i * 8 + 4, shi[i], true)
  }
  return out
}

/** HashV1 摘要（32 字节）。空输入也有定义（pad 落在 rate 首字节）。 */
export function hashV1(data: Uint8Array): Uint8Array {
  const slo = new Uint32Array(25)
  const shi = new Uint32Array(25)
  const blo = new Uint32Array(25)
  const bhi = new Uint32Array(25)

  let off = 0
  while (off + RATE <= data.length) {
    absorbBlock(slo, shi, data, off)
    keccakF23(slo, shi, blo, bhi)
    off += RATE
  }

  const final = new Uint8Array(RATE)
  final.set(data.subarray(off))
  final[data.length - off] = 0x06
  final[RATE - 1] |= 0x80
  absorbBlock(slo, shi, final, 0)
  keccakF23(slo, shi, blo, bhi)

  return squeeze32(slo, shi)
}

/** 挑战前像前缀：`<salt>_<expireAt>_`（nonce 十进制拼在其后）。 */
export function buildPrefix(salt: string, expireAt: number): string {
  return `${salt}_${expireAt}_`
}

/** 上游 /api/v0/chat/create_pow_challenge 返回的挑战体。 */
export interface PowChallenge {
  algorithm: string
  challenge: string
  salt: string
  expire_at: number
  difficulty: number
  expire_after?: number
  signature: string
  target_path: string
}

/** difficulty 缺省值（上游实测）。 */
export const DEFAULT_DIFFICULTY = 144000

/** 支持的算法名：安卓 App 用 DeepSeekHashV1，Web 客户端用 HashV1，同一套。 */
const SUPPORTED_ALGORITHMS = ['HashV1', 'DeepSeekHashV1']

function hexToBytes32(hex: string): Uint8Array {
  if (hex.length !== 64) throw new Error('pow: challenge must be 64 hex chars')
  const out = fromHex(hex)
  if (out.length !== 32) throw new Error('pow: challenge must be 64 hex chars')
  return out
}

export interface SolvePowOptions {
  /** 中断信号：每 1024 个 nonce 检查一次，对齐 Go 版 ctx 的粒度。 */
  signal?: AbortSignal
}

/**
 * 在 [0, difficulty) 内找出使 HashV1("<salt>_<expireAt>_<n>") == challenge 的 n。
 * 找不到（difficulty 太小或挑战不属于该 salt）时抛错——不返回哨兵值，避免调用方误用 0。
 */
export function solvePow(
  challengeHex: string,
  salt: string,
  expireAt: number,
  difficulty: number,
  options: SolvePowOptions = {},
): number {
  const target = hexToBytes32(challengeHex)
  const tv = new DataView(target.buffer, target.byteOffset, 32)
  const wantLo = [tv.getUint32(0, true), tv.getUint32(8, true), tv.getUint32(16, true), tv.getUint32(24, true)]
  const wantHi = [tv.getUint32(4, true), tv.getUint32(12, true), tv.getUint32(20, true), tv.getUint32(28, true)]

  const signal = options.signal

  // 前缀预吸收：整块直接吸收并置换，余下的尾巴留给热循环。
  const prefix = utf8(buildPrefix(salt, expireAt))
  const baseLo = new Uint32Array(25)
  const baseHi = new Uint32Array(25)
  const blo = new Uint32Array(25)
  const bhi = new Uint32Array(25)

  let off = 0
  while (off + RATE <= prefix.length) {
    absorbBlock(baseLo, baseHi, prefix, off)
    keccakF23(baseLo, baseHi, blo, bhi)
    off += RATE
  }
  const tailLen = prefix.length - off
  const tail = new Uint8Array(RATE)
  tail.set(prefix.subarray(off))

  const slo = new Uint32Array(25)
  const shi = new Uint32Array(25)
  const numBuf = new Uint8Array(20)
  const blk1 = new Uint8Array(RATE)
  const blk2 = new Uint8Array(RATE)

  for (let n = 0; n < difficulty; n++) {
    if ((n & 0x3ff) === 0 && signal?.aborted) {
      throw new Error('pow: aborted')
    }

    // nonce 的十进制 ASCII（对齐 Go 的手写转换，不用 String(n)）
    let pos = 20
    if (n === 0) {
      pos--
      numBuf[pos] = 0x30
    } else {
      let v = n
      while (v > 0) {
        pos--
        numBuf[pos] = 0x30 + (v % 10)
        v = (v / 10) | 0
      }
    }
    const numLen = 20 - pos

    slo.set(baseLo)
    shi.set(baseHi)

    const totalTail = tailLen + numLen
    if (totalTail < RATE) {
      blk1.fill(0)
      blk1.set(tail.subarray(0, tailLen))
      blk1.set(numBuf.subarray(pos, 20), tailLen)
      blk1[totalTail] = 0x06
      blk1[RATE - 1] |= 0x80
      absorbBlock(slo, shi, blk1, 0)
      keccakF23(slo, shi, blo, bhi)
    } else {
      // 前缀尾巴 + nonce 跨过一个整块：分两块吸收。
      const firstLen = RATE - tailLen
      blk1.fill(0)
      blk1.set(tail.subarray(0, tailLen))
      blk1.set(numBuf.subarray(pos, pos + firstLen), tailLen)
      absorbBlock(slo, shi, blk1, 0)
      keccakF23(slo, shi, blo, bhi)

      const rem = totalTail - RATE
      blk2.fill(0)
      blk2.set(numBuf.subarray(pos + firstLen, pos + firstLen + rem))
      blk2[rem] = 0x06
      blk2[RATE - 1] |= 0x80
      absorbBlock(slo, shi, blk2, 0)
      keccakF23(slo, shi, blo, bhi)
    }

    if (slo[0] === wantLo[0] && shi[0] === wantHi[0] &&
        slo[1] === wantLo[1] && shi[1] === wantHi[1] &&
        slo[2] === wantLo[2] && shi[2] === wantHi[2] &&
        slo[3] === wantLo[3] && shi[3] === wantHi[3]) {
      return n
    }
  }

  throw new Error('pow: no solution within difficulty')
}

/** 组装 x-ds-pow-response：base64(JSON)。字段名与顺序对齐 Go 版
 * （difficulty / expire_at 刻意排除——带上会被上游判为篡改挑战）。
 */
export function buildPowHeader(challenge: PowChallenge, answer: number): string {
  const payload = JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  })
  return base64Encode(utf8(payload))
}

/** 端到端：挑战 → 应答头。difficulty 为 0 时用默认值 144000。 */
export function solveAndBuildHeader(
  challenge: PowChallenge,
  options: SolvePowOptions = {},
): string {
  if (!SUPPORTED_ALGORITHMS.includes(challenge.algorithm)) {
    throw new Error(`pow: unsupported algorithm ${JSON.stringify(challenge.algorithm)}`)
  }
  const difficulty = challenge.difficulty || DEFAULT_DIFFICULTY
  const answer = solvePow(challenge.challenge, challenge.salt, challenge.expire_at, difficulty, options)
  return buildPowHeader(challenge, answer)
}
