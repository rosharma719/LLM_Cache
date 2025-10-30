// src/embeddings/provider.ts
export interface EmbeddingProvider {
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>; // always return Float32
}
