import type { FastifyRequest } from 'fastify';

const PUBLIC_EXACT = new Set([
  '/health',
  '/meta',
  '/templates',
  '/legistar/catalog',
  '/files',
  '/meetings',
  '/bodies',
  '/publications',
]);

const PUBLIC_PREFIXES = ['/templates/', '/files/', '/meetings/'];

export function isPublicPath(url: string, method = 'GET'): boolean {
  const path = url.split('?')[0] ?? url;
  if (path.startsWith('/auth/')) return true;
  if (method !== 'GET') return false;
  return PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function denyAnonymous(
  req: FastifyRequest,
  requireUser: (req: FastifyRequest) => Promise<unknown>,
) {
  if (isPublicPath(req.url, req.method)) return;
  await requireUser(req);
}
