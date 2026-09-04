const VECTOR_DIMENSIONS = 1024;

/** 返回经过 L2 normalization 的 1024 维 Float32 向量。 */
export function normalizeVector(value: unknown): Float32Array {
  if (!Array.isArray(value) || value.length !== VECTOR_DIMENSIONS) {
    throw new TypeError(`Embedding 向量必须为 ${VECTOR_DIMENSIONS} 维`);
  }
  let squaredNorm = 0;
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  for (let index = 0; index < value.length; index += 1) {
    const item = Number(value[index]);
    if (!Number.isFinite(item)) throw new TypeError("Embedding 向量包含非法数值");
    vector[index] = item;
    squaredNorm += item * item;
  }
  if (squaredNorm === 0) throw new TypeError("Embedding 服务返回了零向量");
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
  return vector;
}

/** 计算两个已归一化向量的 cosine；维度不一致时明确失败。 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length !== VECTOR_DIMENSIONS) {
    throw new TypeError(`Cosine 计算要求两个 ${VECTOR_DIMENSIONS} 维向量`);
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index]! * right[index]!;
  return Math.max(-1, Math.min(1, score));
}

/** 将 Float32 向量复制为稳定的 little-endian SQLite BLOB。 */
export function vectorToBlob(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) view.setFloat32(index * 4, vector[index]!, true);
  return bytes;
}

/** 从 SQLite BLOB 恢复 1024 维 Float32 向量。 */
export function vectorFromBlob(blob: Uint8Array): Float32Array {
  if (blob.byteLength !== VECTOR_DIMENSIONS * 4) throw new TypeError("向量 BLOB 长度无效");
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  for (let index = 0; index < vector.length; index += 1) vector[index] = view.getFloat32(index * 4, true);
  return vector;
}

export { VECTOR_DIMENSIONS };

