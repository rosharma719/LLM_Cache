// src/chunking/simple.ts
export interface Chunk {
  seq: number;
  text: string;
}

export function chunkText(text: string, size = 1200, overlap = 150): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0, seq = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    chunks.push({ seq, text: text.slice(i, end) });
    seq += 1;
    i = end - overlap;
    if (i < 0) i = 0;
    if (i >= text.length) break;
  }
  return chunks;
}
