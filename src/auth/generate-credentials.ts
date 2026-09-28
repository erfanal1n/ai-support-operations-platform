import { randomBytes } from 'node:crypto';
import type { OperatorRole } from './session.js';

const [id, role] = process.argv.slice(2);
if (!id || !/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(id) || (role !== 'agent' && role !== 'supervisor')) {
  process.stderr.write('Usage: pnpm auth:config -- <operator-id> <agent|supervisor>\n');
  process.exitCode = 1;
} else {
  const operatorRole: OperatorRole = role;
  const secret = randomBytes(48).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const credentials = JSON.stringify([{ id, role: operatorRole, token }]);

  process.stdout.write(`AUTH_MODE=session\nSESSION_SECRET=${secret}\nSUPPORT_OPERATOR_TOKENS='${credentials}'\n`);
}
