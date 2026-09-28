import OpenAI from 'openai';

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string
  ) {
    this.client = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 2 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      encoding_format: 'float',
    });
    const ordered = [...response.data].sort((left, right) => left.index - right.index);

    if (ordered.length !== texts.length) {
      throw new Error('Embedding response did not match the input count');
    }

    return ordered.map(({ embedding }) => embedding);
  }
}
