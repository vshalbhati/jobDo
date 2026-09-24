import express from 'express';
import { config, validateConfig } from './config.js';
import { api } from './routes.js';

const problems = validateConfig();
if (problems.length) {
  console.error('Configuration problems:\n  - ' + problems.join('\n  - '));
  console.error('\nCopy .env.example to .env and fill it in, then start with: npm start');
  if (process.env.NODE_ENV !== 'test') process.exit(1);
}

export const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(express.json({ limit: '12mb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

// The frontend is deployed on its own origin and sends cookies, so the origin
// has to be echoed exactly - a wildcard is not allowed with credentials, and
// would be wrong here anyway. Chrome extension origins are always permitted;
// they authenticate with a bearer token, never a cookie.
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (config.corsOrigins.includes(origin.replace(/\/$/, '')) || EXTENSION_ORIGIN.test(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Max-Age', '600');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  providers: config.providers,
  signupOpen: config.allowSignup
}));

app.use('/api', api);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request is too large.' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON.' });
  }
  console.error(err);
  // Never hand an internal message to the client.
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(config.port, config.host, () => {
    console.log('Easy Apply API on http://' + config.host + ':' + config.port);
    console.log('  providers     ' + config.providers);
    console.log('  cors origins  ' + (config.corsOrigins.join(', ') || '(none - browser calls will be blocked)'));
    console.log('  cookies       SameSite=' + config.cookieSameSite + (config.cookieSecure ? '; Secure' : ''));
    if (config.providers === 'memory') {
      console.log('\n  WARNING: running with in-memory providers. Nothing is persisted.');
    }
  });
}

export default app;