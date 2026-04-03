const express = require('express');
const cors    = require('cors');
require('dotenv').config();

// Import database connection (this will test the connection on startup)
const db = require('./db/index');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: '*' }));

// ── Routes ──────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/shifts',   require('./routes/shifts'));
app.use('/api/locations',require('./routes/locations'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/settings', require('./routes/settings'));

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