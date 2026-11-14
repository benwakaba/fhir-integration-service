// Tiny structured logger: one line per event, key=value fields. LOG_FORMAT=json
// switches to JSON lines. Never pass resource bodies or demographics as fields.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(name, { level = process.env.LOG_LEVEL ?? 'info', format = process.env.LOG_FORMAT } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const json = format === 'json';

  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const line = json
      ? JSON.stringify({ time: new Date().toISOString(), level: lvl, component: name, msg, ...fields })
      : `${new Date().toISOString().slice(11, 23)} ${lvl.toUpperCase().padEnd(5)} [${name}] ${msg}${formatFields(fields)}`;
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

function formatFields(fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}
