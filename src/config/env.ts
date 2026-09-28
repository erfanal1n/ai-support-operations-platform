import 'dotenv/config';
import { z } from 'zod';

const operatorTokensSchema = z.array(z.object({
  id: z.string().trim().min(1).max(120),
  role: z.enum(['agent', 'supervisor']),
  token: z.string().min(32),
}).strict()).superRefine((operators, context) => {
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const [index, operator] of operators.entries()) {
    if (ids.has(operator.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Operator IDs must be unique' });
    }
    if (tokens.has(operator.token)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'token'], message: 'Operator tokens must be unique' });
    }
    ids.add(operator.id);
    tokens.add(operator.token);
  }
});

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: z.enum(['disabled', 'session']).default('disabled'),
  SESSION_SECRET: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(32).optional()
  ),
  SUPPORT_OPERATOR_TOKENS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? '[]' : value),
    z.string().default('[]').transform((value, context) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a JSON array of operator credentials' });
        return [];
      }

      const result = operatorTokensSchema.safeParse(parsed);
      if (!result.success) {
        for (const issue of result.error.issues) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: issue.path,
            message: issue.message,
          });
        }
        return [];
      }
      return result.data;
    })
  ),
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
  if (config.NODE_ENV === 'production' && config.AUTH_MODE !== 'session') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_MODE'],
      message: 'Session authentication is required in production',
    });
  }
  if (config.NODE_ENV === 'production' && config.STORAGE_MODE !== 'postgres') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STORAGE_MODE'],
      message: 'PostgreSQL storage is required in production',
    });
  }
  if (config.AUTH_MODE === 'session' && !config.SESSION_SECRET) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_SECRET'],
      message: 'SESSION_SECRET must contain at least 32 characters when session authentication is enabled',
    });
  }
  if (config.AUTH_MODE === 'session' && config.SUPPORT_OPERATOR_TOKENS.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SUPPORT_OPERATOR_TOKENS'],
      message: 'At least one operator token is required when session authentication is enabled',
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
