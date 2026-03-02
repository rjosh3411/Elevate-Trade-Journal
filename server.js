const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { execFile } = require('child_process');

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(crypto.scrypt);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TRADE_IMAGES_DIR = path.join(DATA_DIR, 'trade_images');
const DB_PATH = path.join(DATA_DIR, 'trade_journal.db');
const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const SESSION_COOKIE_NAME = 'tj_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_BODY_BYTES = 1_000_000;
const MAX_TRADE_IMAGE_BYTES = 5 * 1024 * 1024;
const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;

const OAUTH_STATES = new Map();

const OAUTH_PROVIDER_DEFS = {
    google: {
        label: 'Google',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        scope: 'openid email profile'
    },
    apple: {
        label: 'Apple',
        authUrl: 'https://appleid.apple.com/auth/authorize',
        tokenUrl: 'https://appleid.apple.com/auth/token',
        scope: 'name email',
        clientIdEnv: 'APPLE_CLIENT_ID',
        usesJwtClientSecret: true
    }
};

const STATIC_ROUTES = {
    '/': 'tradejournal2.0.html',
    '/tradejournal2.0.html': 'tradejournal2.0.html',
    '/styles.css': 'styles.css',
    '/signup.js': 'signup.js',
    '/dashboard.css': 'dashboard.css',
    '/dashboard.js': 'dashboard.js',
    '/journal.css': 'journal.css',
    '/journal.js': 'journal.js',
    '/calendar.css': 'calendar.css',
    '/calendar.js': 'calendar.js'
};

function sqlValue(value) {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }

    return `'${String(value).replace(/'/g, "''")}'`;
}

function parseCookies(cookieHeader) {
    if (!cookieHeader) {
        return {};
    }

    return cookieHeader.split(';').reduce((acc, pair) => {
        const [rawKey, ...rawValue] = pair.trim().split('=');

        if (!rawKey) {
            return acc;
        }

        acc[rawKey] = decodeURIComponent(rawValue.join('=') || '');
        return acc;
    }, {});
}

function mimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.html') {
        return 'text/html; charset=utf-8';
    }

    if (ext === '.css') {
        return 'text/css; charset=utf-8';
    }

    if (ext === '.js') {
        return 'application/javascript; charset=utf-8';
    }

    if (ext === '.json') {
        return 'application/json; charset=utf-8';
    }

    if (ext === '.txt') {
        return 'text/plain; charset=utf-8';
    }

    return 'application/octet-stream';
}

function tradeImageMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();

    if (ext === '.png') {
        return 'image/png';
    }

    if (ext === '.jpg' || ext === '.jpeg') {
        return 'image/jpeg';
    }

    if (ext === '.webp') {
        return 'image/webp';
    }

    if (ext === '.gif') {
        return 'image/gif';
    }

    return '';
}

function imageExtFromMime(mime) {
    const normalized = String(mime || '').toLowerCase();

    if (normalized === 'image/png') {
        return 'png';
    }

    if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
        return 'jpg';
    }

    if (normalized === 'image/webp') {
        return 'webp';
    }

    if (normalized === 'image/gif') {
        return 'gif';
    }

    return '';
}

function isSafeImageFileName(fileName) {
    return /^[a-zA-Z0-9_.-]+$/.test(fileName);
}

async function runSql(sql) {
    await execFileAsync('sqlite3', [DB_PATH, sql]);
}

async function allSql(sql) {
    const { stdout } = await execFileAsync('sqlite3', ['-json', DB_PATH, sql]);

    if (!stdout.trim()) {
        return [];
    }

    return JSON.parse(stdout);
}

async function initDb() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.mkdir(TRADE_IMAGES_DIR, { recursive: true });

    const schemaSql = `
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS oauth_identities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            provider_user_id TEXT NOT NULL,
            email TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(provider, provider_user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            result TEXT CHECK (result IN ('win', 'loss')) NOT NULL,
            pnl REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_oauth_identities_user_id ON oauth_identities(user_id);
        CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
    `;

    await runSql(schemaSql);

    await ensureTradeColumns();
    await cleanupExpiredSessions();
}

async function ensureTradeColumns() {
    const columns = await allSql(`PRAGMA table_info(trades);`);
    const existing = new Set(columns.map((column) => column.name));

    const additions = [
        { name: 'symbol', sql: `ALTER TABLE trades ADD COLUMN symbol TEXT DEFAULT '';` },
        { name: 'setup_name', sql: `ALTER TABLE trades ADD COLUMN setup_name TEXT DEFAULT '';` },
        { name: 'confidence', sql: `ALTER TABLE trades ADD COLUMN confidence INTEGER DEFAULT 5;` },
        { name: 'notes', sql: `ALTER TABLE trades ADD COLUMN notes TEXT DEFAULT '';` },
        { name: 'trade_date', sql: `ALTER TABLE trades ADD COLUMN trade_date TEXT DEFAULT '';` },
        { name: 'screenshot_path', sql: `ALTER TABLE trades ADD COLUMN screenshot_path TEXT DEFAULT '';` }
    ];

    for (const addition of additions) {
        if (!existing.has(addition.name)) {
            await runSql(addition.sql);
        }
    }
}

async function cleanupExpiredSessions() {
    const nowIso = new Date().toISOString();
    await runSql(`DELETE FROM sessions WHERE expires_at <= ${sqlValue(nowIso)};`);
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password, salt) {
    const derived = await scryptAsync(password, salt, 64);
    return derived.toString('hex');
}

function isStrongPassword(password) {
    return (
        typeof password === 'string' &&
        password.length >= 8 &&
        /[A-Za-z]/.test(password) &&
        /[0-9]/.test(password)
    );
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function setSessionCookie(res, token, expiresAtMs) {
    const maxAge = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
    res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
    const cookie = `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
    res.setHeader('Set-Cookie', cookie);
}

function toBase64Url(input) {
    const source = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    return source
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function decodeBase64Url(input) {
    const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function parseJwtPayload(idToken) {
    const parts = String(idToken || '').split('.');

    if (parts.length !== 3) {
        throw new Error('Invalid identity token format.');
    }

    try {
        return JSON.parse(decodeBase64Url(parts[1]));
    } catch {
        throw new Error('Invalid identity token payload.');
    }
}

function createAppleClientSecret(config) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = nowSeconds + (60 * 60 * 24 * 170);

    const header = {
        alg: 'ES256',
        kid: config.keyId,
        typ: 'JWT'
    };

    const payload = {
        iss: config.teamId,
        iat: nowSeconds,
        exp: expiresAtSeconds,
        aud: 'https://appleid.apple.com',
        sub: config.clientId
    };

    const encodedHeader = toBase64Url(JSON.stringify(header));
    const encodedPayload = toBase64Url(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto.sign('sha256', Buffer.from(unsignedToken), {
        key: config.privateKey,
        dsaEncoding: 'ieee-p1363'
    });

    return `${unsignedToken}.${toBase64Url(signature)}`;
}

function getOAuthProviderConfig(providerKey) {
    const baseConfig = OAUTH_PROVIDER_DEFS[providerKey];

    if (!baseConfig) {
        return null;
    }

    const clientId = process.env[baseConfig.clientIdEnv] || '';

    if (baseConfig.usesJwtClientSecret) {
        const teamId = process.env.APPLE_TEAM_ID || '';
        const keyId = process.env.APPLE_KEY_ID || '';
        const privateKeyRaw = process.env.APPLE_PRIVATE_KEY || '';

        if (!clientId || !teamId || !keyId || !privateKeyRaw) {
            return null;
        }

        return {
            ...baseConfig,
            providerKey,
            clientId,
            teamId,
            keyId,
            privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
            redirectUri: `${APP_BASE_URL}/auth/oauth/${providerKey}/callback`
        };
    }

    const clientSecret = process.env[baseConfig.clientSecretEnv] || '';

    if (!clientId || !clientSecret) {
        return null;
    }

    return {
        ...baseConfig,
        providerKey,
        clientId,
        clientSecret,
        redirectUri: `${APP_BASE_URL}/auth/oauth/${providerKey}/callback`
    };
}

function createOAuthState(providerKey) {
    const state = crypto.randomBytes(18).toString('hex');
    OAUTH_STATES.set(state, {
        providerKey,
        createdAt: Date.now()
    });
    return state;
}

function consumeOAuthState(state, providerKey) {
    const record = OAUTH_STATES.get(state);

    if (!record) {
        return false;
    }

    OAUTH_STATES.delete(state);

    if (record.providerKey !== providerKey) {
        return false;
    }

    if ((Date.now() - record.createdAt) > OAUTH_STATE_TTL_MS) {
        return false;
    }

    return true;
}

function cleanupOAuthStates() {
    const cutoff = Date.now() - OAUTH_STATE_TTL_MS;

    for (const [state, record] of OAUTH_STATES.entries()) {
        if (record.createdAt < cutoff) {
            OAUTH_STATES.delete(state);
        }
    }
}

async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(token);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await runSql(`
        INSERT INTO sessions(token_hash, user_id, created_at, expires_at)
        VALUES(${sqlValue(tokenHash)}, ${sqlValue(userId)}, ${sqlValue(createdAt)}, ${sqlValue(expiresAt)});
    `);

    return {
        token,
        expiresAtMs: Date.parse(expiresAt)
    };
}

async function getSessionUser(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];

    if (!token) {
        return null;
    }

    const tokenHash = hashSessionToken(token);
    const nowIso = new Date().toISOString();

    const rows = await allSql(`
        SELECT
            users.id,
            users.full_name AS fullName,
            users.email,
            users.created_at AS createdAt,
            sessions.expires_at AS sessionExpiresAt
        FROM sessions
        INNER JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ${sqlValue(tokenHash)}
          AND sessions.expires_at > ${sqlValue(nowIso)}
        LIMIT 1;
    `);

    if (!rows.length) {
        return null;
    }

    return rows[0];
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let chunks = '';

        req.on('data', (chunk) => {
            chunks += chunk;

            if (Buffer.byteLength(chunks, 'utf8') > maxBytes) {
                reject(new Error('Request body too large.'));
                req.destroy();
            }
        });

        req.on('end', () => resolve(chunks));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const raw = await readRawBody(req);

    if (!raw.trim()) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('Invalid JSON payload.');
    }
}

async function serveStatic(res, pathname) {
    const fileName = STATIC_ROUTES[pathname];

    if (!fileName) {
        return false;
    }

    const filePath = path.join(ROOT, fileName);
    const data = await fs.promises.readFile(filePath);

    res.writeHead(200, {
        'Content-Type': mimeType(filePath),
        'Content-Length': data.length
    });

    res.end(data);
    return true;
}

async function handleAuthSignup(req, res) {
    const body = await readJsonBody(req);

    const fullName = String(body.fullName || '').trim();
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    const agreeTerms = Boolean(body.agreeTerms);

    if (fullName.length < 2) {
        sendJson(res, 400, { ok: false, error: 'Please enter your full name.' });
        return;
    }

    if (!isValidEmail(email)) {
        sendJson(res, 400, { ok: false, error: 'Please enter a valid email address.' });
        return;
    }

    if (!isStrongPassword(password)) {
        sendJson(res, 400, {
            ok: false,
            error: 'Password must be at least 8 characters and include letters and numbers.'
        });
        return;
    }

    if (password !== confirmPassword) {
        sendJson(res, 400, { ok: false, error: 'Password and confirmation must match.' });
        return;
    }

    if (!agreeTerms) {
        sendJson(res, 400, { ok: false, error: 'Please agree to the Terms and Privacy Policy.' });
        return;
    }

    const existing = await allSql(`
        SELECT id FROM users WHERE email = ${sqlValue(email)} LIMIT 1;
    `);

    if (existing.length) {
        sendJson(res, 409, { ok: false, error: 'An account with this email already exists.' });
        return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, salt);
    const createdAt = new Date().toISOString();

    await runSql(`
        INSERT INTO users(full_name, email, password_hash, password_salt, created_at)
        VALUES(
            ${sqlValue(fullName)},
            ${sqlValue(email)},
            ${sqlValue(passwordHash)},
            ${sqlValue(salt)},
            ${sqlValue(createdAt)}
        );
    `);

    const users = await allSql(`
        SELECT id, full_name AS fullName, email FROM users
        WHERE email = ${sqlValue(email)}
        LIMIT 1;
    `);

    const user = users[0];
    const session = await createSession(user.id);

    setSessionCookie(res, session.token, session.expiresAtMs);

    sendJson(res, 201, {
        ok: true,
        user,
        redirect: '/dashboard'
    });
}

async function handleAuthLogin(req, res) {
    const body = await readJsonBody(req);

    const email = normalizeEmail(body.email);
    const password = String(body.password || '');

    if (!isValidEmail(email)) {
        sendJson(res, 400, { ok: false, error: 'Please enter a valid email address.' });
        return;
    }

    if (!password) {
        sendJson(res, 400, { ok: false, error: 'Please enter your password.' });
        return;
    }

    const users = await allSql(`
        SELECT id, full_name AS fullName, email, password_hash AS passwordHash, password_salt AS passwordSalt
        FROM users
        WHERE email = ${sqlValue(email)}
        LIMIT 1;
    `);

    if (!users.length) {
        sendJson(res, 401, { ok: false, error: 'Invalid email or password.' });
        return;
    }

    const user = users[0];
    const incomingHash = await hashPassword(password, user.passwordSalt);

    const savedHashBuffer = Buffer.from(user.passwordHash, 'hex');
    const incomingHashBuffer = Buffer.from(incomingHash, 'hex');

    if (
        savedHashBuffer.length !== incomingHashBuffer.length ||
        !crypto.timingSafeEqual(savedHashBuffer, incomingHashBuffer)
    ) {
        sendJson(res, 401, { ok: false, error: 'Invalid email or password.' });
        return;
    }

    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAtMs);

    sendJson(res, 200, {
        ok: true,
        user: {
            id: user.id,
            fullName: user.fullName,
            email: user.email
        },
        redirect: '/dashboard'
    });
}

async function handleAuthLogout(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];

    if (token) {
        const tokenHash = hashSessionToken(token);
        await runSql(`DELETE FROM sessions WHERE token_hash = ${sqlValue(tokenHash)};`);
    }

    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
}

async function handleAuthSession(req, res) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJson(res, 200, { ok: true, loggedIn: false, user: null });
        return;
    }

    sendJson(res, 200, {
        ok: true,
        loggedIn: true,
        user: {
            id: user.id,
            fullName: user.fullName,
            email: user.email,
            createdAt: user.createdAt
        }
    });
}

function getOAuthProviderHealth(providerKey) {
    const baseConfig = OAUTH_PROVIDER_DEFS[providerKey];
    const missingEnv = [];

    if (!baseConfig) {
        return {
            provider: providerKey,
            configured: false,
            missingEnv: ['UNKNOWN_PROVIDER'],
            startPath: null,
            callbackUrl: null
        };
    }

    if (!(process.env[baseConfig.clientIdEnv] || '')) {
        missingEnv.push(baseConfig.clientIdEnv);
    }

    if (baseConfig.usesJwtClientSecret) {
        if (!(process.env.APPLE_TEAM_ID || '')) {
            missingEnv.push('APPLE_TEAM_ID');
        }

        if (!(process.env.APPLE_KEY_ID || '')) {
            missingEnv.push('APPLE_KEY_ID');
        }

        if (!(process.env.APPLE_PRIVATE_KEY || '')) {
            missingEnv.push('APPLE_PRIVATE_KEY');
        }
    } else if (!(process.env[baseConfig.clientSecretEnv] || '')) {
        missingEnv.push(baseConfig.clientSecretEnv);
    }

    return {
        provider: providerKey,
        label: baseConfig.label,
        configured: missingEnv.length === 0,
        missingEnv,
        startPath: `/auth/oauth/${providerKey}/start`,
        callbackUrl: `${APP_BASE_URL}/auth/oauth/${providerKey}/callback`
    };
}

async function handleAuthConfigHealth(_req, res) {
    const providers = {};
    const providerKeys = Object.keys(OAUTH_PROVIDER_DEFS);
    let allOauthConfigured = true;

    for (const providerKey of providerKeys) {
        const providerHealth = getOAuthProviderHealth(providerKey);
        providers[providerKey] = providerHealth;

        if (!providerHealth.configured) {
            allOauthConfigured = false;
        }
    }

    sendJson(res, 200, {
        ok: true,
        status: allOauthConfigured ? 'ready' : 'needs_configuration',
        timestamp: new Date().toISOString(),
        appBaseUrl: APP_BASE_URL,
        emailPasswordAuth: {
            enabled: true
        },
        oauth: {
            configuredProviderCount: providerKeys.length,
            allConfigured: allOauthConfigured,
            providers
        }
    });
}

function redirectAuthError(res, message) {
    const safeMessage = message || 'Could not complete sign-in.';
    redirect(res, `/?auth_error=${encodeURIComponent(safeMessage)}#signup`);
}

async function fetchOAuthTokens(config, code) {
    const clientSecret = config.usesJwtClientSecret
        ? createAppleClientSecret(config)
        : config.clientSecret;

    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: clientSecret
    });

    const tokenResponse = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    const tokenData = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenData || (!tokenData.access_token && !tokenData.id_token)) {
        throw new Error('Token exchange failed.');
    }

    return tokenData;
}

async function fetchOAuthUserInfo(config, tokenData) {
    if (config.providerKey === 'apple') {
        if (!tokenData.id_token) {
            throw new Error('Identity token was not returned.');
        }

        return parseJwtPayload(tokenData.id_token);
    }

    const profileResponse = await fetch(config.userInfoUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const profileData = await profileResponse.json().catch(() => null);

    if (!profileResponse.ok || !profileData) {
        throw new Error('Could not load user profile.');
    }

    return profileData;
}

function buildOAuthProfile(profileData, fallbackProfile) {
    const fallback = fallbackProfile || {};
    const providerUserId = String(
        profileData.sub ||
        profileData.id ||
        profileData.user_id ||
        ''
    ).trim();

    const email = normalizeEmail(
        profileData.email ||
        profileData.preferred_username ||
        fallback.email ||
        ''
    );

    const fullName = String(
        profileData.name ||
        `${profileData.given_name || ''} ${profileData.family_name || ''}`.trim() ||
        fallback.fullName ||
        (email ? email.split('@')[0] : 'Trader')
    ).trim();

    return {
        providerUserId,
        email,
        fullName: fullName || 'Trader'
    };
}

async function findOrCreateOAuthUser(providerKey, profile) {
    const identityRows = await allSql(`
        SELECT users.id, users.full_name AS fullName, users.email
        FROM oauth_identities
        INNER JOIN users ON users.id = oauth_identities.user_id
        WHERE oauth_identities.provider = ${sqlValue(providerKey)}
          AND oauth_identities.provider_user_id = ${sqlValue(profile.providerUserId)}
        LIMIT 1;
    `);

    if (identityRows.length) {
        return identityRows[0];
    }

    if (!profile.email) {
        return null;
    }

    let userRows = await allSql(`
        SELECT id, full_name AS fullName, email
        FROM users
        WHERE email = ${sqlValue(profile.email)}
        LIMIT 1;
    `);

    if (!userRows.length) {
        const salt = crypto.randomBytes(16).toString('hex');
        const pseudoPassword = crypto.randomBytes(24).toString('hex');
        const passwordHash = await hashPassword(pseudoPassword, salt);
        const createdAt = new Date().toISOString();

        await runSql(`
            INSERT INTO users(full_name, email, password_hash, password_salt, created_at)
            VALUES(
                ${sqlValue(profile.fullName)},
                ${sqlValue(profile.email)},
                ${sqlValue(passwordHash)},
                ${sqlValue(salt)},
                ${sqlValue(createdAt)}
            );
        `);

        userRows = await allSql(`
            SELECT id, full_name AS fullName, email
            FROM users
            WHERE email = ${sqlValue(profile.email)}
            LIMIT 1;
        `);
    }

    const user = userRows[0];
    const createdAt = new Date().toISOString();

    const existingIdentity = await allSql(`
        SELECT id
        FROM oauth_identities
        WHERE provider = ${sqlValue(providerKey)}
          AND provider_user_id = ${sqlValue(profile.providerUserId)}
        LIMIT 1;
    `);

    if (!existingIdentity.length) {
        await runSql(`
            INSERT INTO oauth_identities(user_id, provider, provider_user_id, email, created_at)
            VALUES(
                ${sqlValue(user.id)},
                ${sqlValue(providerKey)},
                ${sqlValue(profile.providerUserId)},
                ${sqlValue(profile.email)},
                ${sqlValue(createdAt)}
            );
        `);
    }

    return user;
}

async function handleOAuthStart(res, providerKey) {
    const config = getOAuthProviderConfig(providerKey);

    if (!config) {
        redirectAuthError(res, `${providerKey} sign-in is not configured yet.`);
        return;
    }

    const state = createOAuthState(providerKey);
    const authUrl = new URL(config.authUrl);

    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', config.scope);
    authUrl.searchParams.set('state', state);

    if (providerKey === 'google') {
        authUrl.searchParams.set('prompt', 'select_account');
    }

    if (providerKey === 'apple') {
        authUrl.searchParams.set('response_mode', 'form_post');
    }

    redirect(res, authUrl.toString());
}

async function handleOAuthCallback(req, res, providerKey, url) {
    const config = getOAuthProviderConfig(providerKey);

    if (!config) {
        redirectAuthError(res, `${providerKey} sign-in is not configured yet.`);
        return;
    }

    let params = url.searchParams;

    if (req.method === 'POST') {
        const raw = await readRawBody(req);
        params = new URLSearchParams(raw);
    }

    const incomingError = params.get('error');

    if (incomingError) {
        redirectAuthError(res, 'Sign-in was canceled or denied.');
        return;
    }

    const code = String(params.get('code') || '');
    const state = String(params.get('state') || '');

    if (!code || !state || !consumeOAuthState(state, providerKey)) {
        redirectAuthError(res, 'Could not validate sign-in request.');
        return;
    }

    let fallbackProfile = {};
    const rawUser = params.get('user');

    if (rawUser) {
        try {
            const appleUser = JSON.parse(rawUser);
            const firstName = String(appleUser?.name?.firstName || '').trim();
            const lastName = String(appleUser?.name?.lastName || '').trim();
            const fullName = `${firstName} ${lastName}`.trim();

            fallbackProfile = {
                email: normalizeEmail(appleUser?.email || ''),
                fullName
            };
        } catch {
            fallbackProfile = {};
        }
    }

    const tokenData = await fetchOAuthTokens(config, code);
    const profileData = await fetchOAuthUserInfo(config, tokenData);
    const profile = buildOAuthProfile(profileData, fallbackProfile);

    if (!profile.providerUserId) {
        redirectAuthError(res, 'Email account data was incomplete. Try another provider.');
        return;
    }

    const user = await findOrCreateOAuthUser(providerKey, profile);

    if (!user) {
        redirectAuthError(res, 'Email account data was incomplete. Try signing in again.');
        return;
    }

    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAtMs);
    redirect(res, '/dashboard');
}

async function handleDashboardData(req, res) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
    }

    const rows = await allSql(`
        SELECT
            COUNT(*) AS totalTrades,
            SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
            ROUND(COALESCE(SUM(pnl), 0), 2) AS totalPnl
        FROM trades
        WHERE user_id = ${sqlValue(user.id)};
    `);

    const stats = rows[0] || { totalTrades: 0, wins: 0, totalPnl: 0 };
    const totalTrades = Number(stats.totalTrades || 0);
    const wins = Number(stats.wins || 0);
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;

    sendJson(res, 200, {
        ok: true,
        stats: {
            totalTrades,
            winRate,
            totalPnl: Number(stats.totalPnl || 0)
        }
    });
}

async function handleJournalImageUpload(req, res) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
    }

    const raw = await readRawBody(req, MAX_TRADE_IMAGE_BYTES * 2);
    let body = {};

    try {
        body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON payload.' });
        return;
    }
    const imageDataUrl = String(body.imageDataUrl || '').trim();
    const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

    if (!match) {
        sendJson(res, 400, { ok: false, error: 'Please upload a valid image file.' });
        return;
    }

    const mime = match[1].toLowerCase();
    const ext = imageExtFromMime(mime);

    if (!ext) {
        sendJson(res, 400, { ok: false, error: 'Only PNG, JPG, WEBP, or GIF images are supported.' });
        return;
    }

    const imageBytes = Buffer.from(match[2], 'base64');

    if (!imageBytes.length) {
        sendJson(res, 400, { ok: false, error: 'Image file is empty.' });
        return;
    }

    if (imageBytes.length > MAX_TRADE_IMAGE_BYTES) {
        sendJson(res, 400, { ok: false, error: 'Image must be 5MB or smaller.' });
        return;
    }

    const imageFile = `${user.id}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const imagePath = path.join(TRADE_IMAGES_DIR, imageFile);

    await fs.promises.writeFile(imagePath, imageBytes);

    sendJson(res, 201, {
        ok: true,
        imageFile,
        imageUrl: `/api/journal/images/${encodeURIComponent(imageFile)}`
    });
}

async function handleJournalImageGet(req, res, imageFile) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
    }

    const normalizedFile = String(imageFile || '').trim();

    if (!normalizedFile || !isSafeImageFileName(normalizedFile)) {
        sendJson(res, 400, { ok: false, error: 'Invalid image path.' });
        return;
    }

    if (!normalizedFile.startsWith(`${user.id}_`)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden' });
        return;
    }

    const mime = tradeImageMimeType(normalizedFile);

    if (!mime) {
        sendJson(res, 400, { ok: false, error: 'Unsupported image format.' });
        return;
    }

    const absolutePath = path.join(TRADE_IMAGES_DIR, normalizedFile);

    let imageBuffer;

    try {
        imageBuffer = await fs.promises.readFile(absolutePath);
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            sendJson(res, 404, { ok: false, error: 'Image not found.' });
            return;
        }

        throw error;
    }

    res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': imageBuffer.length,
        'Cache-Control': 'private, max-age=3600'
    });
    res.end(imageBuffer);
}

async function handleJournalEntriesGet(req, res) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
    }

    const entries = await allSql(`
        SELECT
            id,
            trade_date AS tradeDate,
            symbol,
            setup_name AS setup,
            result,
            ROUND(COALESCE(pnl, 0), 2) AS pnl,
            COALESCE(confidence, 5) AS confidence,
            screenshot_path AS screenshotFile,
            notes,
            created_at AS createdAt
        FROM trades
        WHERE user_id = ${sqlValue(user.id)}
        ORDER BY trade_date DESC, id DESC
        LIMIT 100;
    `);

    const statsRows = await allSql(`
        SELECT
            COUNT(*) AS totalTrades,
            SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
            ROUND(COALESCE(SUM(pnl), 0), 2) AS totalPnl
        FROM trades
        WHERE user_id = ${sqlValue(user.id)};
    `);

    const stats = statsRows[0] || { totalTrades: 0, wins: 0, totalPnl: 0 };
    const totalTrades = Number(stats.totalTrades || 0);
    const wins = Number(stats.wins || 0);
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;

    sendJson(res, 200, {
        ok: true,
        entries,
        stats: {
            totalTrades,
            winRate,
            totalPnl: Number(stats.totalPnl || 0)
        }
    });
}

async function handleJournalEntriesPost(req, res) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
    }

    const body = await readJsonBody(req);

    const tradeDate = String(body.tradeDate || '').trim();
    const symbol = String(body.symbol || '').trim().toUpperCase();
    const setupName = String(body.setup || '').trim();
    const result = String(body.result || '').trim().toLowerCase();
    const pnl = Number(body.pnl);
    const confidence = Number(body.confidence);
    const notes = String(body.notes || '').trim();
    const screenshotFile = String(body.screenshotFile || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
        sendJson(res, 400, { ok: false, error: 'Please provide a valid trade date.' });
        return;
    }

    if (symbol.length > 12) {
        sendJson(res, 400, { ok: false, error: 'Symbol must be 12 characters or fewer.' });
        return;
    }

    if (setupName.length < 2 || setupName.length > 80) {
        sendJson(res, 400, { ok: false, error: 'Setup must be between 2 and 80 characters.' });
        return;
    }

    if (!['win', 'loss'].includes(result)) {
        sendJson(res, 400, { ok: false, error: 'Result must be either win or loss.' });
        return;
    }

    if (!Number.isFinite(pnl)) {
        sendJson(res, 400, { ok: false, error: 'Please enter a valid P&L value.' });
        return;
    }

    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 10) {
        sendJson(res, 400, { ok: false, error: 'Confidence must be an integer between 1 and 10.' });
        return;
    }

    if (notes.length > 1000) {
        sendJson(res, 400, { ok: false, error: 'Notes must be 1000 characters or fewer.' });
        return;
    }

    if (screenshotFile) {
        if (!isSafeImageFileName(screenshotFile) || !screenshotFile.startsWith(`${user.id}_`)) {
            sendJson(res, 400, { ok: false, error: 'Invalid screenshot image.' });
            return;
        }

        const screenshotPath = path.join(TRADE_IMAGES_DIR, screenshotFile);

        try {
            await fs.promises.access(screenshotPath, fs.constants.R_OK);
        } catch {
            sendJson(res, 400, { ok: false, error: 'Screenshot image was not found. Please upload it again.' });
            return;
        }
    }

    const createdAt = new Date().toISOString();

    await runSql(`
        INSERT INTO trades(
            user_id,
            result,
            pnl,
            created_at,
            symbol,
            setup_name,
            confidence,
            screenshot_path,
            notes,
            trade_date
        )
        VALUES(
            ${sqlValue(user.id)},
            ${sqlValue(result)},
            ${sqlValue(pnl)},
            ${sqlValue(createdAt)},
            ${sqlValue(symbol)},
            ${sqlValue(setupName)},
            ${sqlValue(confidence)},
            ${sqlValue(screenshotFile)},
            ${sqlValue(notes)},
            ${sqlValue(tradeDate)}
        );
    `);

    sendJson(res, 201, { ok: true });
}

function normalizeMonthParam(monthParam) {
    if (!monthParam) {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const raw = String(monthParam).trim();

    if (!/^\d{4}-\d{2}$/.test(raw)) {
        return '';
    }

    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(5, 7));

    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return '';
    }

    return raw;
}

function getMonthRange(month) {
    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;
    const startDate = new Date(Date.UTC(year, monthIndex, 1));
    const endDate = new Date(Date.UTC(year, monthIndex + 1, 1));

    const toDateOnly = (date) => date.toISOString().slice(0, 10);

    return {
        start: toDateOnly(startDate),
        end: toDateOnly(endDate)
    };
}

async function handleCalendarEntriesGet(req, res, url) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
    }

    const month = normalizeMonthParam(url.searchParams.get('month'));

    if (!month) {
        sendJson(res, 400, { ok: false, error: 'Month must be in YYYY-MM format.' });
        return;
    }

    const { start, end } = getMonthRange(month);

    const entries = await allSql(`
        SELECT
            id,
            trade_date AS tradeDate,
            symbol,
            setup_name AS setup,
            result,
            ROUND(COALESCE(pnl, 0), 2) AS pnl,
            COALESCE(confidence, 5) AS confidence,
            screenshot_path AS screenshotFile,
            notes,
            created_at AS createdAt
        FROM trades
        WHERE user_id = ${sqlValue(user.id)}
          AND trade_date >= ${sqlValue(start)}
          AND trade_date < ${sqlValue(end)}
        ORDER BY trade_date ASC, id DESC;
    `);

    sendJson(res, 200, {
        ok: true,
        month,
        entries
    });
}

async function serveProtectedPage(req, res, fileName) {
    const user = await getSessionUser(req);

    if (!user) {
        redirect(res, '/#signup');
        return;
    }

    const filePath = path.join(ROOT, fileName);
    const data = await fs.promises.readFile(filePath);

    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': data.length
    });

    res.end(data);
}

async function serveDashboard(req, res) {
    await serveProtectedPage(req, res, 'dashboard.html');
}

async function serveJournal(req, res) {
    await serveProtectedPage(req, res, 'journal.html');
}

async function serveCalendar(req, res) {
    await serveProtectedPage(req, res, 'calendar.html');
}

function methodNotAllowed(res) {
    sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
}

async function requestListener(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
        const journalImageMatch = pathname.match(/^\/api\/journal\/images\/([^/]+)$/);

        if (journalImageMatch) {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await handleJournalImageGet(req, res, decodeURIComponent(journalImageMatch[1]));
            return;
        }

        const oauthRouteMatch = pathname.match(/^\/auth\/oauth\/([a-z0-9_-]+)\/(start|callback)$/i);

        if (oauthRouteMatch) {
            const providerKey = oauthRouteMatch[1].toLowerCase();
            const action = oauthRouteMatch[2].toLowerCase();

            if (!OAUTH_PROVIDER_DEFS[providerKey]) {
                redirectAuthError(res, 'Unsupported sign-in provider.');
                return;
            }

            if (action === 'start') {
                if (req.method !== 'GET') {
                    methodNotAllowed(res);
                    return;
                }

                await handleOAuthStart(res, providerKey);
                return;
            }

            if (req.method !== 'GET' && req.method !== 'POST') {
                methodNotAllowed(res);
                return;
            }

            try {
                await handleOAuthCallback(req, res, providerKey, url);
            } catch (error) {
                console.error(`OAuth callback failed for ${providerKey}:`, error);
                redirectAuthError(res, 'Could not complete sign-in. Please try again.');
            }

            return;
        }

        if (pathname === '/api/auth/signup') {
            if (req.method !== 'POST') {
                methodNotAllowed(res);
                return;
            }

            await handleAuthSignup(req, res);
            return;
        }

        if (pathname === '/api/auth/login') {
            if (req.method !== 'POST') {
                methodNotAllowed(res);
                return;
            }

            await handleAuthLogin(req, res);
            return;
        }

        if (pathname === '/api/auth/logout') {
            if (req.method !== 'POST') {
                methodNotAllowed(res);
                return;
            }

            await handleAuthLogout(req, res);
            return;
        }

        if (pathname === '/api/auth/session') {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await handleAuthSession(req, res);
            return;
        }

        if (pathname === '/api/auth/health') {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await handleAuthConfigHealth(req, res);
            return;
        }

        if (pathname === '/api/journal/upload-image') {
            if (req.method !== 'POST') {
                methodNotAllowed(res);
                return;
            }

            await handleJournalImageUpload(req, res);
            return;
        }

        if (pathname === '/api/dashboard/data') {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await handleDashboardData(req, res);
            return;
        }

        if (pathname === '/api/journal/entries') {
            if (req.method === 'GET') {
                await handleJournalEntriesGet(req, res);
                return;
            }

            if (req.method === 'POST') {
                await handleJournalEntriesPost(req, res);
                return;
            }

            methodNotAllowed(res);
            return;
        }

        if (pathname === '/api/calendar/entries') {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await handleCalendarEntriesGet(req, res, url);
            return;
        }

        if (pathname === '/dashboard') {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await serveDashboard(req, res);
            return;
        }

        if (pathname === '/journal') {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await serveJournal(req, res);
            return;
        }

        if (pathname === '/calendar') {
            if (req.method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            await serveCalendar(req, res);
            return;
        }

        const served = await serveStatic(res, pathname);

        if (!served) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
        }
    } catch (error) {
        let statusCode = 500;
        let message = 'Internal server error.';

        if (error.message === 'Invalid JSON payload.') {
            statusCode = 400;
            message = error.message;
        } else if (error.message === 'Request body too large.') {
            statusCode = 413;
            message = error.message;
        }

        if (statusCode === 500) {
            console.error(error);
        }

        sendJson(res, statusCode, { ok: false, error: message });
    }
}

async function main() {
    await initDb();

    setInterval(() => {
        cleanupExpiredSessions().catch((error) => {
            console.error('Session cleanup failed:', error);
        });

        cleanupOAuthStates();
    }, 1000 * 60 * 60);

    const server = http.createServer(requestListener);

    server.listen(PORT, () => {
        console.log(`Trade Journal server running at http://localhost:${PORT}`);
    });
}

main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
