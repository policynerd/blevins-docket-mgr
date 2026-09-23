import type { FastifyRequest } from 'fastify';

const PUBLIC = new Set(['/health', '/meta', '/templates']);

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (PUBLIC.has(path)) return true;
  if (path.startsWith('/templates/')) return true;
  if (path.startsWith('/auth/')) return true;
  return false;
}

export async function denyAnonymous(
  req: FastifyRequest,
  requireUser: (req: FastifyRequest) => Promise<unknown>,
) {
  if (isPublicPath(req.url)) return;
  await requireUser(req);
}
