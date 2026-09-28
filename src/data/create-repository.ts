import type { Config } from '../config/env.js';
import { db } from './db.js';
import { MemorySupportRepository } from './memory-repository.js';
import { PostgresSupportRepository } from './postgres-repository.js';
import type { SupportRepository } from './repository.js';

export async function createSupportRepository(config: Config): Promise<SupportRepository> {
  if (config.STORAGE_MODE === 'memory') return new MemorySupportRepository(db);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL storage');

  const repository = new PostgresSupportRepository(config.DATABASE_URL);
  try {
    await repository.health();
    return repository;
  } catch (error) {
    await repository.close();
    throw error;
  }
}
