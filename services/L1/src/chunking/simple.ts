// src/chunking/simple.ts
export interface Chunk {
  seq: number;
  text: string;
}

export function chunkText(text: string, size = 1200, overlap = 150): Chunk[] {
  if (size <= 0) throw new Error('chunk size must be positive');

  const step = Math.max(1, size - Math.max(0, overlap));
  const chunks: Chunk[] = [];

  let start = 0;
  let seq = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push({ seq, text: text.slice(start, end) });
    seq += 1;

    if (end === text.length) break;
    start += step;
  }

  if (chunks.length === 0) {
    chunks.push({ seq: 0, text });
  }

  return chunks;
}
