const session = require('express-session');
const { db } = require('./db');

// A minimal express-session store backed by the app's own SQLite DB, so
// sessions persist on the same disk `data.db` already lives on — no extra
// dependency needed. Without this, express-session's default MemoryStore
// forgets every logged-in session the moment the process restarts (Render
// spinning the dyno down/up, a redeploy, etc.), which is what caused users
// to suddenly get "Not authenticated" mid-flow despite the page still
// looking logged in.
class SqliteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.prepare(`
        INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sess), expires);
      cb && cb();
    } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb();
    } catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = { SqliteSessionStore };
