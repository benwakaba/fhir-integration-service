import { createApp } from './app.js';
import { config } from './config.js';
import { createLogger } from './log.js';

const log = createLogger('server');

createApp().listen(config.port, () => {
  log.info(`listening on http://localhost:${config.port}`, { publicBaseUrl: config.publicBaseUrl });
});
