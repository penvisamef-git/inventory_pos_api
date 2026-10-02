// In-memory cache for the per-request auth lookups (API key, session, user).
// Every protected request used to make 3 DB calls before any real work; now it makes 0 while cached.
// Short TTL because each server instance (e.g. each Vercel function) has its own cache:
// a logout / role change is seen everywhere within TTL. On this instance it is cleared at once
// by the model hooks (User / Session changes → clearAuthCache()).
const TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 30000);
const MAX = 1000;
const sessions = new Map(); // access_token → { session, user, at }

function getAuth(token) {
  const hit = sessions.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return hit;
}

function setAuth(token, session, user) {
  if (sessions.size >= MAX) sessions.delete(sessions.keys().next().value); // drop the oldest
  sessions.set(token, { session, user, at: Date.now() });
}

function clearAuthCache() {
  sessions.clear();
}

module.exports = { getAuth, setAuth, clearAuthCache, TTL_MS };
