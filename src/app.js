import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { requireApiKey } from './middleware/auth.js';
import conformanceRoutes from './routes/conformance.js';
import fhirRoutes from './routes/fhir.js';
import ingestRoutes from './routes/ingest.js';
import patientRoutes from './routes/patients.js';
import terminologyRoutes from './routes/terminology.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false); // ETags here are FHIR version tags, set explicitly per resource
  app.use(express.json({ limit: '25mb', type: ['application/json', 'application/fhir+json'] }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use(requireApiKey);

  app.use('/fhir', fhirRoutes);
  app.use('/patients', patientRoutes);
  app.use(terminologyRoutes);
  app.use(conformanceRoutes);
  app.use(ingestRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
