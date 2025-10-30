// src/embeddings/openai.ts
import { EmbeddingProvider } from './provider';
import { config } from '../config';

type OpenAIEmbeddingResponse = {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
};

const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export class OpenAIProvider implements EmbeddingProvider {
  dim: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint = 'https://api.openai.com/v1/embeddings';

  constructor() {
    this.apiKey = config.embeddings.openai.apiKey;
    this.model = config.embeddings.openai.model;
    this.dim = MODEL_DIMENSIONS[this.model] ?? 0;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!Array.isArray(texts)) throw new TypeError('texts must be an array of strings');
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!res.ok) {
      const detail = await safeErrorBody(res);
      throw new Error(`OpenAI embeddings error: ${res.status} ${res.statusText}${detail}`);
    }

    const payload = (await res.json()) as OpenAIEmbeddingResponse;
    if (!payload?.data || payload.data.length !== texts.length) {
      throw new Error('OpenAI embeddings response malformed or incomplete');
    }

    const vectors = payload.data
      .sort((a, b) => a.index - b.index)
      .map((entry) => {
        if (!Array.isArray(entry.embedding)) {
          throw new Error('OpenAI embedding missing vector data');
        }
        return Float32Array.from(entry.embedding);
      });

    if (!this.dim && vectors[0]) {
      this.dim = vectors[0].length;
    }

    return vectors;
  }
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? ` - ${text}` : '';
  } catch {
    return '';
  }
}
