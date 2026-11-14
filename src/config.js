import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const port = Number(process.env.PORT || 5051);

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  port,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  apiKey: process.env.API_KEY || null,
  requestTimeoutMs: Number(process.env.FHIR_REQUEST_TIMEOUT_MS || 30000),
  sourceBaseUrls: {
    smart: process.env.SMART_BASE_URL || 'https://r4.smarthealthit.org',
    hapi: process.env.HAPI_BASE_URL || 'https://hapi.fhir.org/baseR4',
  },
};
