import { FHIR_JSON, operationOutcome } from '../fhir/present.js';
import { createLogger } from '../log.js';

const log = createLogger('http');

// FHIR routes answer errors with an OperationOutcome; the developer API with { error }.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err.redirect) return res.redirect(err.status, req.originalUrl.replace(err.redirect.from, err.redirect.to));
  const parseError = err.type === 'entity.parse.failed';
  const status = parseError ? 400 : (err.status ?? 500);
  const message = parseError ? 'Request body is not valid JSON' : status >= 500 ? 'Internal server error' : err.message;
  if (status >= 500) log.error('request failed', { method: req.method, path: req.path, error: err.stack ?? String(err) });
  for (const [name, value] of Object.entries(err.headers ?? {})) res.set(name, value);

  if (req.path.startsWith('/fhir')) {
    const code = parseError ? 'structure' : status >= 500 ? 'exception' : (err.code ?? 'processing');
    return res.status(status).type(FHIR_JSON).json(operationOutcome('error', code, message, err.issues ?? []));
  }
  res.status(status).json({ error: message, ...(err.issues && { issues: err.issues }) });
}

export function notFoundHandler(req, res, next) {
  const err = new Error(`No route for ${req.method} ${req.path}`);
  err.status = 404;
  err.code = 'not-supported';
  next(err);
}
