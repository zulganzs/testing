require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================================
// SQLITE DATABASE — persistent storage for sensor readings
// ============================================================
const DB_PATH = path.join(__dirname, 'database.db');
const db = new Database(DB_PATH);

// Pragmas for safety + performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema (idempotent: safe to run on every boot)
db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ppm        REAL    NOT NULL DEFAULT 0,
    adc        INTEGER NOT NULL DEFAULT 0,
    flame      INTEGER NOT NULL DEFAULT 1,
    dist       REAL    NOT NULL DEFAULT 0,
    water_pct  REAL    NOT NULL DEFAULT 0,
    pump       INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sensor_readings_ts
    ON sensor_readings (timestamp DESC);

  CREATE TABLE IF NOT EXISTS connection_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    status    TEXT    NOT NULL,
    timestamp TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_connection_logs_ts
    ON connection_logs (timestamp DESC);
`);

// ============================================================
// CONFIG / CONSTANTS
// ============================================================

// ESP CONNECTION STATUS — ESP32 posts every 2s; if no data
// arrives within ESP_STALE_MS, we consider it disconnected.
const ESP_STALE_MS = 10000;

// History (last 100 readings returned by /api/history)
const MAX_HISTORY = 100;

// Persistence cap — keep only the last 1000 readings on disk
const MAX_STORED_READINGS = 1000;

// Default "no data yet" response shape (matches original in-memory defaults)
const DEFAULT_LATEST = Object.freeze({
  ppm: 0,
  adc: 0,
  flame: 1,
  dist: 0,
  water_pct: 0,
  pump: 0,
  timestamp: null
});

// ============================================================
// PREPARED STATEMENTS (compiled once, reused)
// ============================================================

const stmtInsertReading = db.prepare(`
  INSERT INTO sensor_readings (ppm, adc, flame, dist, water_pct, pump, timestamp)
  VALUES (@ppm, @adc, @flame, @dist, @water_pct, @pump, @timestamp)
`);

const stmtLatestReading = db.prepare(`
  SELECT ppm, adc, flame, dist, water_pct, pump, timestamp
  FROM sensor_readings
  ORDER BY id DESC
  LIMIT 1
`);

const stmtHistory = db.prepare(`
  SELECT ppm, adc, flame, dist, water_pct, pump, timestamp
  FROM sensor_readings
  ORDER BY id DESC
  LIMIT ?
`);

const stmtCountReadings = db.prepare(`
  SELECT COUNT(*) AS n FROM sensor_readings
`);

const stmtPruneReadings = db.prepare(`
  DELETE FROM sensor_readings
  WHERE id IN (
    SELECT id FROM sensor_readings
    ORDER BY id DESC
    LIMIT -1 OFFSET ?
  )
`);

const stmtInsertConnectionLog = db.prepare(`
  INSERT INTO connection_logs (status, timestamp)
  VALUES (?, ?)
`);

// ============================================================
// DB HELPERS
// ============================================================

// Read the most recent row as a plain object matching the old API shape.
function readLatestData() {
  const row = stmtLatestReading.get();
  if (!row) return { ...DEFAULT_LATEST };
  return {
    ppm: row.ppm,
    adc: row.adc,
    flame: row.flame,
    dist: row.dist,
    water_pct: row.water_pct,
    pump: row.pump,
    timestamp: row.timestamp
  };
}

function readHistory(limit = MAX_HISTORY) {
  // stmtHistory returns rows newest-first; the old in-memory store
  // returned rows oldest-first (push order). Preserve that contract.
  const rows = stmtHistory.all(limit);
  return rows
    .slice()
    .reverse()
    .map(r => ({
      ppm: r.ppm,
      adc: r.adc,
      flame: r.flame,
      dist: r.dist,
      water_pct: r.water_pct,
      pump: r.pump,
      timestamp: r.timestamp
    }));
}

function pruneOldReadingsIfNeeded() {
  const { n } = stmtCountReadings.get();
  if (n > MAX_STORED_READINGS) {
    // Keep the newest MAX_STORED_READINGS rows; delete the rest.
    const removed = db.transaction(() => {
      const info = stmtPruneReadings.run(MAX_STORED_READINGS);
      return info.changes;
    })();
    if (removed > 0) {
      console.log(`[KODE Backend] Pruned ${removed} old sensor readings (kept last ${MAX_STORED_READINGS})`);
    }
  }
}

// ============================================================
// ESP CONNECTION CHECK — uses latest reading timestamp from DB
// ============================================================

function isEspConnected(latest) {
  if (!latest || !latest.timestamp) return false;
  const t = new Date(latest.timestamp).getTime();
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) < ESP_STALE_MS;
}

// ============================================================
// API KEY AUTH — the ESP32 must send this header
// ============================================================
const API_KEY = process.env.API_KEY || 'KODE_IOT_SECRET_KEY_2024';

function authenticate(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' });
  }
  next();
}

// ============================================================
// ROUTES
// ============================================================

// ESP32 POSTs sensor data here
app.post('/api/data', authenticate, (req, res) => {
  const { ppm, adc, flame, dist, water_pct, pump } = req.body;

  // Validate required fields
  if (ppm === undefined || flame === undefined || dist === undefined) {
    return res.status(400).json({ error: 'Missing required sensor fields' });
  }

  const reading = {
    ppm: parseFloat(ppm) || 0,
    adc: parseInt(adc) || 0,
    flame: parseInt(flame) ?? 1,
    dist: parseFloat(dist) || 0,
    water_pct: parseFloat(water_pct) || 0,
    pump: parseInt(pump) || 0,
    timestamp: new Date().toISOString()
  };

  // Insert reading + connection log atomically, then prune if needed.
  db.transaction(() => {
    stmtInsertReading.run(reading);
    stmtInsertConnectionLog.run('online', reading.timestamp);
  })();

  pruneOldReadingsIfNeeded();

  console.log(`[${reading.timestamp}] PPM=${reading.ppm} Flame=${reading.flame} Water=${reading.water_pct}% Pump=${reading.pump}`);

  res.json({ status: 'ok', received: reading });
});

// Frontend GETs current data (public — no auth needed for dashboard)
app.get('/api/data', (req, res) => {
  const latest = readLatestData();
  res.json({ ...latest, esp_connected: isEspConnected(latest) });
});

// Get data history (last MAX_HISTORY readings, oldest-first)
app.get('/api/history', (req, res) => {
  res.json(readHistory(MAX_HISTORY));
});

// ESP connection status — frontend polls this to check if ESP32 is alive
app.get('/api/status', (req, res) => {
  const latest = readLatestData();
  res.json({
    esp_connected: isEspConnected(latest),
    last_seen: latest.timestamp,
    stale_threshold_ms: ESP_STALE_MS,
    uptime: process.uptime()
  });
});

// Health check
app.get('/api/health', (req, res) => {
  const latest = readLatestData();
  const { n: readingsStored } = stmtCountReadings.get();
  res.json({
    status: 'online',
    uptime: process.uptime(),
    lastUpdate: latest.timestamp,
    readingsStored
  });
});

// Root — simple status page
app.get('/', (req, res) => {
  res.json({
    name: 'KODE IoT Monitoring Backend',
    version: '1.1.0',
    storage: 'sqlite',
    endpoints: {
      'POST /api/data': 'ESP32 sends sensor data (requires x-api-key header)',
      'GET  /api/data': 'Get latest sensor data (public)',
      'GET  /api/status': 'ESP connection status (public)',
      'GET  /api/history': 'Get last 100 readings (public)',
      'GET  /api/health': 'Health check'
    }
  });
});

// ============================================================
// GRACEFUL SHUTDOWN — close DB cleanly on signals / exceptions
// ============================================================
function shutdown(reason) {
  console.log(`[KODE Backend] Shutting down (${reason})...`);
  try { db.close(); } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[KODE Backend] Uncaught exception:', err);
  shutdown('uncaughtException');
});

// Start server
app.listen(PORT, () => {
  const { n } = stmtCountReadings.get();
  console.log(`[KODE Backend] Server running on port ${PORT}`);
  console.log(`[KODE Backend] SQLite DB: ${DB_PATH}`);
  console.log(`[KODE Backend] Stored readings on boot: ${n}`);
  console.log(`[KODE Backend] API Key: ${API_KEY.substring(0, 4)}...`);
  console.log(`[KODE Backend] Endpoints:`);
  console.log(`   POST /api/data   — ESP32 sends data`);
  console.log(`   GET  /api/data   — Dashboard reads data`);
  console.log(`   GET  /api/status — ESP connection status`);
  console.log(`   GET  /api/health — Health check`);
});
