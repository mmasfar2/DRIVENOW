require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const path = require('path');
require('./db'); // initializes + seeds the database

const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const vehicleRoutes = require('./routes/vehicles');
const dashboardRoutes = require('./routes/dashboard');
const messageRoutes = require('./routes/messages');

const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', 1); // Render terminates TLS at its proxy; trust X-Forwarded-* so secure cookies work

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'drivenow-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    secure: process.env.NODE_ENV === 'production',
  },
}));

// CORS for the public marketing site (GitHub Pages) to submit applications/contact forms
app.use((req, res, next) => {
  const allowedOrigin = process.env.PUBLIC_SITE_ORIGIN || '*';
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/messages', messageRoutes);

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`DriveNow backend running on port ${PORT}`);
});
