const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory store for latest sensor data
let latestData = {
  ppm: 0,
  adc: 0,
  flame: 1,
  dist: 0,
  water_pct: 0,
  pump: 0,
  timestamp: null
};

// History (last 100 readings)
const MAX_HISTORY = 100;
const dataHistory = [];

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

  latestData = {
    ppm: parseFloat(ppm) || 0,
    adc: parseInt(adc) || 0,
    flame: parseInt(flame) ?? 1,
    dist: parseFloat(dist) || 0,
    water_pct: parseFloat(water_pct) || 0,
    pump: parseInt(pump) || 0,
    timestamp: new Date().toISOString()
  };

  // Push to history
  dataHistory.push({ ...latestData });
  if (dataHistory.length > MAX_HISTORY) {
    dataHistory.shift();
  }

  console.log(`[${latestData.timestamp}] PPM=${latestData.ppm} Flame=${latestData.flame} Water=${latestData.water_pct}% Pump=${latestData.pump}`);

  res.json({ status: 'ok', received: latestData });
});

// Frontend GETs current data (public — no auth needed for dashboard)
app.get('/api/data', (req, res) => {
  res.json(latestData);
});

// Get data history
app.get('/api/history', (req, res) => {
  res.json(dataHistory);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    lastUpdate: latestData.timestamp,
    readingsStored: dataHistory.length
  });
});

// Root — simple status page
app.get('/', (req, res) => {
  res.json({
    name: 'KODE IoT Monitoring Backend',
    version: '1.0.0',
    endpoints: {
      'POST /api/data': 'ESP32 sends sensor data (requires x-api-key header)',
      'GET  /api/data': 'Get latest sensor data (public)',
      'GET  /api/history': 'Get last 100 readings (public)',
      'GET  /api/health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[KODE Backend] Server running on port ${PORT}`);
  console.log(`[KODE Backend] API Key: ${API_KEY.substring(0, 4)}...`);
  console.log(`[KODE Backend] Endpoints:`);
  console.log(`   POST /api/data   — ESP32 sends data`);
  console.log(`   GET  /api/data   — Dashboard reads data`);
  console.log(`   GET  /api/health — Health check`);
});
