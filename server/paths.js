const path = require('path');

// DATA_DIR points at a persistent disk in production (e.g. Render's /data mount);
// falls back to the app folder for local development.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

module.exports = { DATA_DIR, UPLOADS_DIR };
