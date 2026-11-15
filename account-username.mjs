// Swimmer usernames: one rule set for activation and for changing a username later.
// Usernames are case-insensitive and stored in lower case ("Amelia1" signs in as amelia1 or Amelia1).
// A username used before by another account stays reserved, so nobody can take over a name that
// coaches, parents or old messages still associate with someone else.
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'owner', 'softwareowner', 'software-owner', 'athlyrax', 'support', 'help', 'root', 'system', 'security', 'coach', 'headcoach', 'head-coach', 'swimmer', 'athlete', 'guardian', 'parent', 'club', 'demo', 'api', 'null', 'undefined', 'me', 'login', 'signin']);
export const normalizeUsername = (value) => String(value ?? '').trim().toLowerCase();

export function usernameProblem(value, { users = [], self = '' } = {}) {
  const name = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(name)) return 'Username must be 3-32 letters, numbers, dot, underscore or dash.';
  if (RESERVED_USERNAMES.has(name) || name.startsWith('athlyrax') || name.startsWith('demo.')) return 'That username is reserved. Please choose another.';
  const me = normalizeUsername(self);
  for (const u of users) {
    const owner = normalizeUsername(u?.username);
    if (owner === me) continue;
    if (owner === name) return 'That username is taken.';
    if ((Array.isArray(u?.previousUsernames) ? u.previousUsernames : []).some((p) => normalizeUsername(p?.username) === name)) return 'That username is taken.';
  }
  return '';
}

// Moves the account link on swimmer records in one club's data from the old to the new username.
// Nothing else in the club data changes; history, results and attendance stay keyed by swimmer id.
export function renameSwimmerLinks(db = {}, oldName, newName) {
  const from = normalizeUsername(oldName); const to = normalizeUsername(newName);
  let changed = 0;
  const swimmers = (Array.isArray(db.swimmers) ? db.swimmers : []).map((row) => {
    if (!row || normalizeUsername(row.swimmerAccountUsername) !== from) return row;
    changed += 1;
    return { ...row, swimmerAccountUsername: to };
  });
  return { db: changed ? { ...db, swimmers } : db, changed };
}

export const hasActiveWearable = (db = {}, username = '') => (Array.isArray(db.athleteWearableConnections) ? db.athleteWearableConnections : [])
  .some((c) => c && c.active !== false && normalizeUsername(c.username) === normalizeUsername(username));
