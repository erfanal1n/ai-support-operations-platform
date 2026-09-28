import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  STORAGE_MODE: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().url().optional()
  ),
  APPROVAL_REFUND_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(10000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  POLICY_RETRIEVAL_MODE: z.enum(['keyword', 'semantic']).default('keyword'),
  AI_TRIAGE_MODE: z.enum(['disabled', 'openai']).default('disabled'),
  OPENAI_API_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional()
  ),
  OPENAI_EMBEDDING_MODEL: z.string().trim().min(1).default('text-embedding-3-small'),
  OPENAI_TRIAGE_MODEL: z.string().trim().min(1).default('gpt-6-luna'),
}).superRefine((config, context) => {
  if (config.POLICY_RETRIEVAL_MODE === 'semantic' && !config.OPENAI_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when semantic policy retrieval is enabled',
    });
  }
  if (config.AI_TRIAGE_MODE === 'openai' && !config.OPENAI_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when AI ticket triage is enabled',
    });
  }
  if (config.STORAGE_MODE === 'postgres' && !config.DATABASE_URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL is required when PostgreSQL storage is enabled',
    });
  }
});

function loadConfig() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return Object.freeze(result.data);
}

export const env = loadConfig();
export type Config = z.infer<typeof EnvSchema>;
