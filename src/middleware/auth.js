import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

// Optional shared-key auth: when API_KEY is set, every request needs
// "Authorization: Bearer <API_KEY>". (Real deployments would put SMART Backend
// Services / OAuth in front; this keeps a demo instance from being wide open.)
export function requireApiKey(req, res, next) {
  if (!config.apiKey || req.path === '/health') return next();
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(config.apiKey);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  next(new HttpError(401, 'Missing or invalid API key', { code: 'login' }));
}
