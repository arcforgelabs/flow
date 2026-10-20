// A fake Clerk adapter (server/auth/clerk.js) for tests: no keys, no network.
// Synthetic people only.
export const TEST_PUBLISHABLE_KEY = `pk_test_${Buffer.from('clerk.example.test$').toString('base64')}`;

export function fakeClerk({ now = Date.now, inviteFails = false } = {}) {
  const users = new Map();
  const sessions = new Map();
  const calls = { authenticate: 0, created: [], invited: [], deleted: [] };
  let counter = 0;

  function addUser({ id = `user_${++counter}`, email, verified = true, google = false, password = true }) {
    users.set(id, {
      id,
      primaryEmailAddressId: `idn_${id}`,
      emailAddresses: [{ id: `idn_${id}`, emailAddress: email, verification: { status: verified ? 'verified' : 'unverified' } }],
      externalAccounts: google ? [{ provider: 'oauth_google', emailAddress: email, verification: { status: 'verified' } }] : [],
      passwordEnabled: password,
      lastSignInAt: null,
      firstName: null,
      lastName: null,
    });
    return id;
  }

  // A session token for this Clerk user. `expiresIn` is in seconds; a
  // negative value makes a token whose `exp` has passed. `secondFactorAge`
  // is minutes since a second factor (-1: none).
  function signIn(userId, { expiresIn = 600, secondFactorAge = -1 } = {}) {
    const token = `sess_${userId}_${++counter}`;
    if (users.has(userId)) users.get(userId).lastSignInAt = now();
    sessions.set(token, {
      userId,
      sessionClaims: { sub: userId, exp: Math.floor(now() / 1000) + expiresIn },
      factorVerificationAge: [0, secondFactorAge],
    });
    return token;
  }

  return {
    calls,
    users,
    addUser,
    signIn,
    signOut: (token) => sessions.delete(token),
    async authenticate(req) {
      calls.authenticate += 1;
      const header = req.headers.authorization ?? '';
      return sessions.get(header.replace(/^Bearer /, '')) ?? null;
    },
    async getUser(id) {
      const user = users.get(id);
      if (!user) throw Object.assign(new Error('not found'), { status: 404 });
      return user;
    },
    async findUserIdByEmail(email) {
      for (const user of users.values()) {
        if (user.emailAddresses.some((address) => address.emailAddress === email)) return user.id;
      }
      return null;
    },
    async createUser({ email }) {
      calls.created.push(email);
      // Made by the backend: verified email, no password. Signing in with
      // Google on that address later joins this account.
      return addUser({ email, google: true, password: false });
    },
    async deleteUser(id) {
      calls.deleted.push(id);
      users.delete(id);
    },
    // Clerk would email a link and make the account when the invitee takes it
    // up; the fake makes it at once (no password, nothing connected).
    async inviteByEmail({ email, redirectUrl }) {
      if (inviteFails) throw new Error('Clerk is unavailable');
      calls.invited.push({ email, redirectUrl });
      addUser({ email, password: false });
    },
  };
}

export async function request(app, path, { token, method = 'GET', body, headers = {} } = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: json, text };
  } finally {
    server.close();
  }
}
