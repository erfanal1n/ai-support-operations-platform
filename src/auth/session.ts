import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type OperatorRole = 'agent' | 'supervisor';

export interface OperatorCredential {
  id: string;
  role: OperatorRole;
  token: string;
}

export interface AuthenticatedOperator {
  id: string;
  role: OperatorRole;
}

export interface IssuedSession {
  cookie: string;
  sessionHash: string;
  operatorId: string;
  credentialHash: string;
  expiresAt: string;
}

export interface SignedSession {
  sessionHash: string;
  expiresAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    operator: AuthenticatedOperator | null;
  }
}

const cookieName = 'support_session';
const sessionLifetimeSeconds = 8 * 60 * 60;
const unknownToken = '0'.repeat(43);

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function authenticateOperator(
  id: string,
  token: string,
  operators: OperatorCredential[]
): AuthenticatedOperator | null {
  const operator = operators.find((item) => item.id === id);
  const expected = tokenDigest(operator?.token ?? unknownToken);
  const received = tokenDigest(token);
  const matches = timingSafeEqual(expected, received);
  return operator && matches ? { id: operator.id, role: operator.role } : null;
}

export function credentialFingerprint(token: string): string {
  return tokenDigest(token).toString('hex');
}

export function loginAttemptKey(ip: string, operatorId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${ip}\0${operatorId.toLowerCase()}`).digest('hex');
}

export function createSession(operator: OperatorCredential, secret: string, secure: boolean): IssuedSession {
  const sessionId = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + sessionLifetimeSeconds * 1000;
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, exp: expiresAt })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    cookie: `${cookieName}=${payload}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeSeconds}${secure ? '; Secure' : ''}`,
    sessionHash: tokenDigest(sessionId).toString('hex'),
    operatorId: operator.id,
    credentialHash: credentialFingerprint(operator.token),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function clearSessionCookie(secure: boolean): string {
  return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

function cookieValue(header: string | undefined): string | null {
  const prefix = `${cookieName}=`;
  const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

export function readSession(cookieHeader: string | undefined, secret: string): SignedSession | null {
  const raw = cookieValue(cookieHeader);
  if (!raw) return null;

  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return null;

  const expected = createHmac('sha256', secret).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sid?: unknown; exp?: unknown };
    if (
      typeof session.sid !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(session.sid) ||
      typeof session.exp !== 'number' ||
      !Number.isSafeInteger(session.exp) ||
      session.exp <= Date.now()
    ) return null;
    if (session.exp > Date.now() + sessionLifetimeSeconds * 1000 + 60_000) return null;
    return {
      sessionHash: tokenDigest(session.sid).toString('hex'),
      expiresAt: new Date(session.exp).toISOString(),
    };
  } catch {
    return null;
  }
}
