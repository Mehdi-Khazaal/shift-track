const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import database connection (this will test the connection on startup)
const db = require('./db/index');
const { dbStatus } = require('./db/index');

// Background scheduler for push notifications
require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50kb' }));

const defaultOrigins = ['https://mehdi-khazaal.github.io', 'http://localhost:3000', 'http://localhost:5500'];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : defaultOrigins;
app.use(cors({ origin: allowedOrigins }));

// Brute-force protection: max 10 auth attempts per IP per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' }),
});

// -- Routes ----------------------------------
app.use('/api/auth',     authLimiter, require('./routes/auth'));
app.use('/api/shifts',   require('./routes/shifts'));
app.use('/api/locations',require('./routes/locations'));
app.use('/api/regions',  require('./routes/regions'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/notifications',   require('./routes/notifications'));
app.use('/api/unavailability',  require('./routes/unavailability'));
app.use('/api/open-shifts',    require('./routes/openShifts'));
app.use('/api/shift-swaps',   require('./routes/swaps'));
app.use('/api/leave',         require('./routes/leave'));

// Health check — used by deploy workflow to confirm the app came up cleanly
app.get('/health', (req, res) => {
  const ok = dbStatus.connected && dbStatus.migrated;
  res.status(ok ? 200 : 503).json({
    ok,
    db_connected: dbStatus.connected,
    db_migrated:  dbStatus.migrated,
    migration_error: dbStatus.migrationError,
    time: new Date().toISOString(),
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`\nOK  ShiftTrack API running on http://localhost:${PORT}\n`);
});