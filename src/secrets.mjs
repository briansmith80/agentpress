import { randomBytes } from 'node:crypto';

/** Shell-safe by construction (alnum only) — DB passwords and .env values get sourced by shell scripts downstream, so avoiding metacharacters matters more than max entropy. */
export function generatePassword(prefix = 'kl') {
  const chunk = () =>
    randomBytes(4)
      .toString('base64url')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .padEnd(4, '0')
      .slice(0, 4);
  return `${prefix}-${chunk()}-${chunk()}`;
}
