import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APPROVAL_REFUND_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(10000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  POLICY_RETRIEVAL_MODE: z.enum(['keyword', 'semantic']).default('keyword'),
  OPENAI_API_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional()
  ),
  OPENAI_EMBEDDING_MODEL: z.string().trim().min(1).default('text-embedding-3-small'),
}).superRefine((config, context) => {
  if (config.POLICY_RETRIEVAL_MODE === 'semantic' && !config.OPENAI_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when semantic policy retrieval is enabled',
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
