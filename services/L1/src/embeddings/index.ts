// src/embeddings/index.ts
import { EmbeddingProvider } from './provider';
import { OpenAIProvider } from './openai';
import { config } from '../config';

let _provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (_provider) return _provider;

  switch (config.embeddings.provider) {
    case 'openai':
      _provider = new OpenAIProvider();
      return _provider;
    default:
      throw new Error(`Unsupported embedding provider: ${config.embeddings.provider}`);
  }
}
