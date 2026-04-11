const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import database connection (this will test the connection on startup)
const db = require('./db/index');

// Background scheduler for push notifications
require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: [
    'https://mehdi-khazaal.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
  ],
}));

// Brute-force protection: max 10 auth attempts per IP per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' }),
});

// ── Routes ──────────────────────────────────
app.use('/api/auth',     authLimiter, require('./routes/auth'));
app.use('/api/shifts',   require('./routes/shifts'));
app.use('/api/locations',require('./routes/locations'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/notifications',   require('./routes/notifications'));
app.use('/api/unavailability',  require('./routes/unavailability'));
app.use('/api/open-shifts',    require('./routes/openShifts'));
app.use('/api/shift-swaps',   require('./routes/swaps'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'ShiftTrack API is running', time: new Date().toISOString() });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`\n✅  ShiftTrack API running on http://localhost:${PORT}\n`);
});