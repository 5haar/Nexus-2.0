import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { OpenAI } from 'openai';
import { WebSocketServer } from 'ws';
import mysql from 'mysql2/promise';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const getUserIdFromHeader = (req: express.Request) => {
  const raw = String(req.header('x-nexus-user-id') ?? '').trim();
  if (!raw) return 'public';
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(raw)) throw new Error('Invalid user id');
  return raw;
};

const writeSse = (res: express.Response, data: unknown) => {
  if (res.writableEnded || res.destroyed) return;
  const json = JSON.stringify(data);
  for (const line of json.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
};

type Analysis = {
  caption: string;
  existingCategories: string[];
  newCategories: string[];
  text: string[];
};

type ScreenshotDoc = {
  id: string;
  userId: string;
  filePath?: string;
  storage?: 'local' | 's3';
  s3Key?: string;
  originalName: string;
  fileMime: string;
  mediaType: 'image' | 'video' | 'other' | 'document';
  caption: string;
  categories: string[];
  text: string;
  embedding: number[];
  createdAt: number;
};

type UserRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  provider?: string;
  providerSub?: string;
  email?: string;
  displayName?: string;
};

type Entitlement = {
  userId: string;
  plan: string;
  status: string;
  source: string;
  productId?: string;
  originalTransactionId?: string;
  expiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

type UsageDaily = {
  userId: string;
  day: string; // YYYY-MM-DD (UTC)
  messagesUsed: number;
  updatedAt: number;
};

type UsageTotals = {
  userId: string;
  uploadsTotal: number;
  createdAt: number;
  updatedAt: number;
};

type StoredData = {
  docs: ScreenshotDoc[];
  users: UserRecord[];
  entitlements: Entitlement[];
  usageDaily: UsageDaily[];
  usageTotals: UsageTotals[];
};

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VISION_MODEL = 'gpt-5.2';
const CHAT_MODEL_DEFAULT = process.env.CHAT_MODEL || VISION_MODEL;
const CHAT_MODEL_ALLOWLIST = (() => {
  const raw = String(process.env.CHAT_MODELS || '').trim();
  const parsed = raw
    ? raw.split(',').map((model) => model.trim()).filter(Boolean)
    : [];
  const fallback = parsed.length ? parsed : [CHAT_MODEL_DEFAULT];
  return Array.from(new Set([...fallback, CHAT_MODEL_DEFAULT]));
})();
const EMBED_MODEL = 'text-embedding-3-small';
const MAX_CATEGORIES_PER_DOC = Number(process.env.MAX_CATEGORIES_PER_DOC || 1);
const MAX_EXISTING_CATEGORIES_CONTEXT = Number(process.env.MAX_EXISTING_CATEGORIES_CONTEXT || 50);
const RAG_TOPK_MAX = Number(process.env.RAG_TOPK_MAX || 6);
const RAG_MIN_COSINE = Number(process.env.RAG_MIN_COSINE || 0.18);
const RAG_LEXICAL_WEIGHT = Number(process.env.RAG_LEXICAL_WEIGHT || 0.08);
const RAG_MIN_HYBRID_SCORE = Number(process.env.RAG_MIN_HYBRID_SCORE || 0.19);
const RAG_DOC_TEXT_MAX_CHARS = Number(process.env.RAG_DOC_TEXT_MAX_CHARS || 420);
const RAG_DOC_CAPTION_MAX_CHARS = Number(process.env.RAG_DOC_CAPTION_MAX_CHARS || 120);
const DOC_TEXT_ANALYSIS_MAX_CHARS = Number(process.env.DOC_TEXT_ANALYSIS_MAX_CHARS || 6000);
const DOC_TEXT_EMBED_MAX_CHARS = Number(process.env.DOC_TEXT_EMBED_MAX_CHARS || 8000);
const DOC_TEXT_STORE_MAX_CHARS = Number(process.env.DOC_TEXT_STORE_MAX_CHARS || 20000);
const PAYWALL_ENFORCED = process.env.PAYWALL_ENFORCED !== '0';
const PLAN_LIMITS = {
  free: { messagesPerDay: 5, uploadsTotal: 5 },
  starter: { messagesPerDay: 100, uploadsTotal: 100 },
  pro: { messagesPerDay: 1000, uploadsTotal: 500 },
  max: { messagesPerDay: null, uploadsTotal: 1000 },
} as const;
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_AUDIENCE = process.env.APPLE_AUDIENCE || '';

if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY is not set. Vision and search will fail.');
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const requireOpenAI = () => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  return openai;
};

const appleJwks = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));
const verifyAppleIdentityToken = async (token: string) => {
  const options: { issuer: string; audience?: string | string[]; clockTolerance?: number } = {
    issuer: APPLE_ISSUER,
    clockTolerance: 10,
  };
  if (APPLE_AUDIENCE) options.audience = APPLE_AUDIENCE;
  const { payload } = await jwtVerify(token, appleJwks, options);
  return payload;
};

const sanitizeModelName = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(text)) return '';
  return text;
};

const resolveChatModel = (value: unknown) => {
  const cleaned = sanitizeModelName(value);
  if (cleaned && CHAT_MODEL_ALLOWLIST.includes(cleaned)) return cleaned;
  return CHAT_MODEL_DEFAULT;
};

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_URL_EXPIRES_SECONDS = Number(process.env.S3_URL_EXPIRES_SECONDS || 3600);
const s3 = S3_BUCKET ? new S3Client({ region: AWS_REGION }) : null;

const DB_HOST = process.env.DB_HOST;
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;
const DB_AUTO_MIGRATE = process.env.DB_AUTO_MIGRATE === '1';
const DB_ENSURE_SCHEMA = process.env.DB_ENSURE_SCHEMA !== '0';

const mysqlPool =
  DB_HOST && DB_USER && DB_NAME
    ? mysql.createPool({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
        waitForConnections: true,
        connectionLimit: 10,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      })
    : null;

const here = path.dirname(fileURLToPath(import.meta.url));
const storageDir = path.join(here, '..', 'storage');
const uploadsDir = path.join(storageDir, 'uploads');
const dbPath = path.join(storageDir, 'data.json');

fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/\s+/g, '-');
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(uploadsDir));

const readDB = (): StoredData => {
  if (!fs.existsSync(dbPath)) {
    return { docs: [], users: [], entitlements: [], usageDaily: [], usageTotals: [] };
  }
  try {
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredData;
    parsed.docs = (parsed.docs ?? []).map((doc: any) => ({
      ...doc,
      userId: typeof doc?.userId === 'string' && doc.userId.trim() ? doc.userId.trim() : 'public',
    }));
    parsed.users = Array.isArray(parsed.users) ? parsed.users : [];
    parsed.entitlements = Array.isArray(parsed.entitlements) ? parsed.entitlements : [];
    parsed.usageDaily = Array.isArray(parsed.usageDaily) ? parsed.usageDaily : [];
    parsed.usageTotals = Array.isArray(parsed.usageTotals) ? parsed.usageTotals : [];
    return parsed;
  } catch (err) {
    console.warn('Failed to read db file', err);
    return { docs: [], users: [], entitlements: [], usageDaily: [], usageTotals: [] };
  }
};

const writeDB = (data: StoredData) => {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

let db: StoredData = readDB();

const ensureMysqlSchema = async () => {
  if (!mysqlPool) return;
  await mysqlPool.execute(
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      provider VARCHAR(32) NULL,
      provider_sub VARCHAR(128) NULL,
      email VARCHAR(255) NULL,
      display_name VARCHAR(255) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
  const addColumnIfMissing = async (table: string, columnDef: string) => {
    try {
      await mysqlPool.execute(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch (err: any) {
      if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  };
  await addColumnIfMissing('users', 'updated_at BIGINT NOT NULL DEFAULT 0');
  await addColumnIfMissing('users', 'provider VARCHAR(32) NULL');
  await addColumnIfMissing('users', 'provider_sub VARCHAR(128) NULL');
  await addColumnIfMissing('users', 'email VARCHAR(255) NULL');
  await addColumnIfMissing('users', 'display_name VARCHAR(255) NULL');
  await mysqlPool.execute(
    `CREATE TABLE IF NOT EXISTS docs (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      file_mime VARCHAR(128) NOT NULL,
      media_type VARCHAR(16) NOT NULL,
      caption TEXT NOT NULL,
      text LONGTEXT NOT NULL,
      embedding LONGTEXT NOT NULL,
      created_at BIGINT NOT NULL,
      storage VARCHAR(16) NOT NULL,
      file_path TEXT NULL,
      s3_key TEXT NULL,
      INDEX idx_docs_user_created (user_id, created_at),
      CONSTRAINT fk_docs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
  await mysqlPool.execute(
    `CREATE TABLE IF NOT EXISTS categories (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      UNIQUE KEY uniq_user_category (user_id, name),
      INDEX idx_categories_user (user_id),
      CONSTRAINT fk_categories_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
  await mysqlPool.execute(
    `CREATE TABLE IF NOT EXISTS doc_categories (
      doc_id VARCHAR(64) NOT NULL,
      category_id BIGINT NOT NULL,
      PRIMARY KEY (doc_id, category_id),
      INDEX idx_dc_category (category_id),
      CONSTRAINT fk_dc_doc FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE,
      CONSTRAINT fk_dc_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
  await mysqlPool.execute(
    `CREATE TABLE IF NOT EXISTS entitlements (
      user_id VARCHAR(64) PRIMARY KEY,
      plan VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      source VARCHAR(32) NOT NULL,
      product_id VARCHAR(128) NULL,
      original_transaction_id VARCHAR(128) NULL,
      expires_at BIGINT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      CONSTRAINT fk_entitlements_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
  await mysqlPool.execute(
    `CREATE TABLE IF NOT EXISTS usage_daily (
      user_id VARCHAR(64) NOT NULL,
      day DATE NOT NULL,
      messages_used INT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, day),
      INDEX idx_usage_daily_user (user_id),
      CONSTRAINT fk_usage_daily_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
  await mysqlPool.execute(
    `CREATE TABLE IF NOT EXISTS usage_totals (
      user_id VARCHAR(64) PRIMARY KEY,
      uploads_total INT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      CONSTRAINT fk_usage_totals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
};

let schemaEnsured: Promise<void> | null = null;
const ensureSchemaOnce = async () => {
  if (!mysqlPool) return;
  if (!DB_ENSURE_SCHEMA) return;
  if (!schemaEnsured) {
    schemaEnsured = ensureMysqlSchema().catch((err) => {
      schemaEnsured = null;
      throw err;
    });
  }
  await schemaEnsured;
};

const normalizeCategoryDbKey = (value: string) => String(value ?? '').trim().toLowerCase();

const canonicalizeCategory = (value: string) => {
  let text = normalizeCategoryDbKey(value);
  if (!text) return '';

  // Remove common list/index prefixes like "0001 ", "1. ", "01) ", etc.
  text = text.replace(/^(?:[#*•\-–—]+\s*)+/, '');
  text = text.replace(/^(?:\(?\d{1,6}\)?[\].):\-–—]*\s+)+/, '');

  // Remove delimiter artifacts from earlier category concatenation bugs.
  text = text.replace(/\\u0001/gi, ' ');
  text = text.replace(/\u0001/g, ' ');
  text = text.replace(/\bu\s*0{3,}\d{1,3}\b/g, ' ');

  // Remove standalone numeric tokens (often OCR artifacts).
  text = text.replace(/\b\d{1,6}\b/g, ' ');

  // Strip punctuation that commonly creeps into short tags.
  text = text.replace(/[^\p{L}\p{N}\s_-]+/gu, ' ');

  // Normalize whitespace.
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^[-_]+|[-_]+$/g, '').trim();

  // Avoid empty or non-informative tags.
  if (!text) return '';
  if (/^\d+$/.test(text)) return '';
  if (!/[a-z]/.test(text)) return '';

  // Keep tags reasonably short.
  if (text.length > 64) text = text.slice(0, 64).trim();
  return text;
};

const ensureUserRow = async (userId: string) => {
  const now = Date.now();
  if (!mysqlPool) {
    const existing = db.users.find((u) => u.id === userId);
    if (!existing) {
      db.users.push({ id: userId, createdAt: now, updatedAt: now });
      writeDB(db);
    }
    return;
  }
  await ensureSchemaOnce();
  await mysqlPool.execute(
    'INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)',
    [userId, now, now],
  );
};

const getUtcDay = () => new Date().toISOString().slice(0, 10);

type PlanId = keyof typeof PLAN_LIMITS;

const normalizePlanId = (value: string): PlanId => {
  const key = String(value ?? '').trim().toLowerCase();
  if (key in PLAN_LIMITS) return key as keyof typeof PLAN_LIMITS;
  return 'free';
};

const resolveEffectivePlan = (entitlement: Entitlement | null): PlanId => {
  if (!entitlement) return 'free';
  const status = String(entitlement.status ?? '').toLowerCase();
  if (status !== 'active') return 'free';
  if (typeof entitlement.expiresAt === 'number' && entitlement.expiresAt > 0 && entitlement.expiresAt <= Date.now()) {
    return 'free';
  }
  return normalizePlanId(entitlement.plan);
};

const getEntitlement = async (userId: string): Promise<Entitlement | null> => {
  await ensureUserRow(userId);
  if (mysqlPool) {
    await ensureSchemaOnce();
    const [rows] = (await mysqlPool.execute(
      `SELECT user_id AS userId, plan, status, source, product_id AS productId,
        original_transaction_id AS originalTransactionId, expires_at AS expiresAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM entitlements WHERE user_id=? LIMIT 1`,
      [userId],
    )) as any[];
    const row = (rows as any[])[0];
    if (!row) return null;
    return {
      userId: String(row.userId),
      plan: String(row.plan ?? 'free'),
      status: String(row.status ?? 'inactive'),
      source: String(row.source ?? 'manual'),
      productId: row.productId ? String(row.productId) : undefined,
      originalTransactionId: row.originalTransactionId ? String(row.originalTransactionId) : undefined,
      expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
      createdAt: Number(row.createdAt ?? Date.now()),
      updatedAt: Number(row.updatedAt ?? Date.now()),
    };
  }

  const entry = db.entitlements.find((e) => e.userId === userId);
  return entry ?? null;
};

const getUsageDaily = async (userId: string, day: string): Promise<UsageDaily> => {
  await ensureUserRow(userId);
  if (mysqlPool) {
    await ensureSchemaOnce();
    const [rows] = (await mysqlPool.execute(
      'SELECT user_id AS userId, day, messages_used AS messagesUsed, updated_at AS updatedAt FROM usage_daily WHERE user_id=? AND day=?',
      [userId, day],
    )) as any[];
    const row = (rows as any[])[0];
    if (row) {
      return {
        userId: String(row.userId),
        day: String(row.day),
        messagesUsed: Number(row.messagesUsed ?? 0),
        updatedAt: Number(row.updatedAt ?? Date.now()),
      };
    }
    return { userId, day, messagesUsed: 0, updatedAt: Date.now() };
  }

  const entry = db.usageDaily.find((u) => u.userId === userId && u.day === day);
  return entry ?? { userId, day, messagesUsed: 0, updatedAt: Date.now() };
};

const incrementUsageDaily = async (userId: string, day: string, delta = 1): Promise<UsageDaily> => {
  await ensureUserRow(userId);
  const now = Date.now();
  if (mysqlPool) {
    await ensureSchemaOnce();
    await mysqlPool.execute(
      `INSERT INTO usage_daily (user_id, day, messages_used, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE messages_used = messages_used + VALUES(messages_used), updated_at = VALUES(updated_at)`,
      [userId, day, delta, now],
    );
    return await getUsageDaily(userId, day);
  }

  const entry = db.usageDaily.find((u) => u.userId === userId && u.day === day);
  if (entry) {
    entry.messagesUsed += delta;
    entry.updatedAt = now;
  } else {
    db.usageDaily.push({ userId, day, messagesUsed: delta, updatedAt: now });
  }
  writeDB(db);
  return await getUsageDaily(userId, day);
};

const getUsageTotals = async (userId: string): Promise<UsageTotals> => {
  await ensureUserRow(userId);
  if (mysqlPool) {
    await ensureSchemaOnce();
    const [rows] = (await mysqlPool.execute(
      'SELECT user_id AS userId, uploads_total AS uploadsTotal, created_at AS createdAt, updated_at AS updatedAt FROM usage_totals WHERE user_id=?',
      [userId],
    )) as any[];
    const row = (rows as any[])[0];
    if (row) {
      return {
        userId: String(row.userId),
        uploadsTotal: Number(row.uploadsTotal ?? 0),
        createdAt: Number(row.createdAt ?? Date.now()),
        updatedAt: Number(row.updatedAt ?? Date.now()),
      };
    }
    return { userId, uploadsTotal: 0, createdAt: Date.now(), updatedAt: Date.now() };
  }

  const entry = db.usageTotals.find((u) => u.userId === userId);
  return entry ?? { userId, uploadsTotal: 0, createdAt: Date.now(), updatedAt: Date.now() };
};

const incrementUploadsTotal = async (userId: string, delta = 1): Promise<UsageTotals> => {
  await ensureUserRow(userId);
  const now = Date.now();
  if (mysqlPool) {
    await ensureSchemaOnce();
    await mysqlPool.execute(
      `INSERT INTO usage_totals (user_id, uploads_total, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE uploads_total = uploads_total + VALUES(uploads_total), updated_at = VALUES(updated_at)`,
      [userId, delta, now, now],
    );
    return await getUsageTotals(userId);
  }

  const entry = db.usageTotals.find((u) => u.userId === userId);
  if (entry) {
    entry.uploadsTotal += delta;
    entry.updatedAt = now;
  } else {
    db.usageTotals.push({ userId, uploadsTotal: delta, createdAt: now, updatedAt: now });
  }
  writeDB(db);
  return await getUsageTotals(userId);
};

const getUserRecord = async (userId: string): Promise<UserRecord> => {
  await ensureUserRow(userId);
  if (mysqlPool) {
    await ensureSchemaOnce();
    const [rows] = (await mysqlPool.execute(
      `SELECT id, created_at AS createdAt, updated_at AS updatedAt,
        provider, provider_sub AS providerSub, email, display_name AS displayName
       FROM users WHERE id=? LIMIT 1`,
      [userId],
    )) as any[];
    const row = (rows as any[])[0];
    if (row) {
      return {
        id: String(row.id),
        createdAt: Number(row.createdAt ?? Date.now()),
        updatedAt: Number(row.updatedAt ?? Date.now()),
        provider: row.provider ? String(row.provider) : undefined,
        providerSub: row.providerSub ? String(row.providerSub) : undefined,
        email: row.email ? String(row.email) : undefined,
        displayName: row.displayName ? String(row.displayName) : undefined,
      };
    }
  }

  const entry = db.users.find((u) => u.id === userId);
  if (entry) return entry;
  const now = Date.now();
  const created: UserRecord = { id: userId, createdAt: now, updatedAt: now };
  db.users.push(created);
  writeDB(db);
  return created;
};

const updateUserProfile = async (userId: string, updates: Partial<UserRecord>) => {
  const now = Date.now();
  await ensureUserRow(userId);
  if (mysqlPool) {
    await ensureSchemaOnce();
    await mysqlPool.execute(
      `UPDATE users
       SET provider=?, provider_sub=?, email=?, display_name=?, updated_at=?
       WHERE id=?`,
      [
        updates.provider ?? null,
        updates.providerSub ?? null,
        updates.email ?? null,
        updates.displayName ?? null,
        now,
        userId,
      ],
    );
    return;
  }
  const entry = db.users.find((u) => u.id === userId);
  if (!entry) return;
  entry.provider = updates.provider ?? entry.provider;
  entry.providerSub = updates.providerSub ?? entry.providerSub;
  entry.email = updates.email ?? entry.email;
  entry.displayName = updates.displayName ?? entry.displayName;
  entry.updatedAt = now;
  writeDB(db);
};

const buildPaywallPayload = (scope: 'messages' | 'uploads', used: number, limit: number | null, plan: string) => ({
  error: 'Payment required',
  code: 'PAYWALL_REQUIRED',
  scope,
  used,
  limit,
  plan,
});

const checkMessageAllowance = async (userId: string) => {
  if (!PAYWALL_ENFORCED) return { allowed: true, plan: 'free', day: getUtcDay(), used: 0, limit: null };
  const day = getUtcDay();
  const entitlement = await getEntitlement(userId);
  const plan = resolveEffectivePlan(entitlement);
  const limit = PLAN_LIMITS[plan].messagesPerDay;
  if (limit == null) return { allowed: true, plan, day, used: 0, limit };
  const usage = await getUsageDaily(userId, day);
  return { allowed: usage.messagesUsed < limit, plan, day, used: usage.messagesUsed, limit };
};

const checkUploadAllowance = async (userId: string) => {
  if (!PAYWALL_ENFORCED) return { allowed: true, plan: 'free', used: 0, limit: null };
  const entitlement = await getEntitlement(userId);
  const plan = resolveEffectivePlan(entitlement);
  const limit = PLAN_LIMITS[plan].uploadsTotal;
  if (limit == null) return { allowed: true, plan, used: 0, limit };
  const usage = await getUsageTotals(userId);
  return { allowed: usage.uploadsTotal < limit, plan, used: usage.uploadsTotal, limit };
};

const upsertCategoryId = async (userId: string, name: string) => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  const normalized = canonicalizeCategory(name);
  if (!normalized) throw new Error('Invalid category');
  const [result] = (await mysqlPool.execute(
    'INSERT INTO categories (user_id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',
    [userId, normalized],
  )) as any;
  return Number(result.insertId) as number;
};

const resolveCategoryIdsInDb = async (userId: string, name: string) => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  const direct = normalizeCategoryDbKey(name);
  const canonical = canonicalizeCategory(name);
  if (!direct && !canonical) return [] as number[];

  const ids = new Set<number>();

  const candidates = Array.from(new Set([direct, canonical].filter(Boolean)));
  if (candidates.length) {
    const placeholders = candidates.map(() => '?').join(',');
    const [rows] = (await mysqlPool.execute(
      `SELECT id FROM categories WHERE user_id=? AND name IN (${placeholders})`,
      [userId, ...candidates],
    )) as any[];
    for (const r of rows as any[]) {
      const id = Number(r.id);
      if (Number.isFinite(id)) ids.add(id);
    }
  }

  if (canonical) {
    // Scan user categories and match by canonicalization (covers older noisy names like "0001 reddit").
    const [allRows] = (await mysqlPool.execute('SELECT id, name FROM categories WHERE user_id=?', [userId])) as any[];
    for (const r of allRows as any[]) {
      if (canonicalizeCategory(String(r.name ?? '')) !== canonical) continue;
      const id = Number(r.id);
      if (Number.isFinite(id)) ids.add(id);
    }
  }

  return Array.from(ids);
};

const listDocsFromDb = async (userId: string, opts?: { includeEmbedding?: boolean }): Promise<ScreenshotDoc[]> => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  await ensureUserRow(userId);
  const includeEmbedding = !!opts?.includeEmbedding;
  const fields = includeEmbedding
    ? 'd.embedding AS embedding'
    : "CAST('[]' AS CHAR) AS embedding";
  const [rows] = (await mysqlPool.execute(
    `SELECT
      d.id,
      d.user_id AS userId,
      d.original_name AS originalName,
      d.file_mime AS fileMime,
      d.media_type AS mediaType,
      d.caption,
      d.text,
      ${fields},
      d.created_at AS createdAt,
      d.storage,
      d.file_path AS filePath,
      d.s3_key AS s3Key,
      GROUP_CONCAT(c.name ORDER BY c.name SEPARATOR 0x01) AS categories
    FROM docs d
    LEFT JOIN doc_categories dc ON dc.doc_id = d.id
    LEFT JOIN categories c ON c.id = dc.category_id
    WHERE d.user_id = ?
    GROUP BY d.id
    ORDER BY d.created_at DESC`,
    [userId],
  )) as any[];

  return (rows as any[]).map((row) => {
    const catsRawOriginal: string =
      typeof row.categories === 'string' ? row.categories : row.categories == null ? '' : String(row.categories);
    const catsRaw = catsRawOriginal.split('\\u0001').join(String.fromCharCode(1));
    const categories: string[] = catsRaw
      ? Array.from(
          new Set<string>(
            catsRaw
              .split('\u0001')
              .map((c: string) => canonicalizeCategory(c))
              .filter(Boolean),
          ),
        )
      : [];
    let embedding: number[] = [];
    if (includeEmbedding) {
      try {
        embedding = JSON.parse(String(row.embedding ?? '[]')) as number[];
      } catch {
        embedding = [];
      }
    }
    return {
      id: String(row.id),
      userId: String(row.userId),
      originalName: String(row.originalName),
      fileMime: String(row.fileMime),
      mediaType: row.mediaType as ScreenshotDoc['mediaType'],
      caption: String(row.caption ?? ''),
      categories,
      text: String(row.text ?? ''),
      embedding,
      createdAt: Number(row.createdAt ?? Date.now()),
      storage: (String(row.storage ?? 'local') as ScreenshotDoc['storage']) ?? 'local',
      filePath: row.filePath ? String(row.filePath) : undefined,
      s3Key: row.s3Key ? String(row.s3Key) : undefined,
    } satisfies ScreenshotDoc;
  });
};

const getDocByIdFromDb = async (userId: string, docId: string): Promise<ScreenshotDoc | null> => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  await ensureUserRow(userId);
  const [rows] = (await mysqlPool.execute(
    `SELECT
      d.id,
      d.user_id AS userId,
      d.original_name AS originalName,
      d.file_mime AS fileMime,
      d.media_type AS mediaType,
      d.caption,
      d.text,
      d.embedding AS embedding,
      d.created_at AS createdAt,
      d.storage,
      d.file_path AS filePath,
      d.s3_key AS s3Key,
      GROUP_CONCAT(c.name ORDER BY c.name SEPARATOR 0x01) AS categories
    FROM docs d
    LEFT JOIN doc_categories dc ON dc.doc_id = d.id
    LEFT JOIN categories c ON c.id = dc.category_id
    WHERE d.user_id = ? AND d.id = ?
    GROUP BY d.id
    LIMIT 1`,
    [userId, docId],
  )) as any[];
  const row = (rows as any[])[0];
  if (!row) return null;
  const catsRawOriginal: string =
    typeof row.categories === 'string' ? row.categories : row.categories == null ? '' : String(row.categories);
  const catsRaw = catsRawOriginal.split('\\u0001').join(String.fromCharCode(1));
  const categories: string[] = catsRaw
    ? Array.from(
        new Set<string>(
          catsRaw
            .split('\u0001')
            .map((c: string) => canonicalizeCategory(c))
            .filter(Boolean),
        ),
      )
    : [];
  let embedding: number[] = [];
  try {
    embedding = JSON.parse(String(row.embedding ?? '[]')) as number[];
  } catch {
    embedding = [];
  }
  return {
    id: String(row.id),
    userId: String(row.userId),
    originalName: String(row.originalName),
    fileMime: String(row.fileMime),
    mediaType: row.mediaType as ScreenshotDoc['mediaType'],
    caption: String(row.caption ?? ''),
    categories,
    text: String(row.text ?? ''),
    embedding,
    createdAt: Number(row.createdAt ?? Date.now()),
    storage: (String(row.storage ?? 'local') as ScreenshotDoc['storage']) ?? 'local',
    filePath: row.filePath ? String(row.filePath) : undefined,
    s3Key: row.s3Key ? String(row.s3Key) : undefined,
  } satisfies ScreenshotDoc;
};

const saveDocToDb = async (doc: ScreenshotDoc) => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  await ensureUserRow(doc.userId);
  await mysqlPool.execute(
    `INSERT INTO docs
      (id, user_id, original_name, file_mime, media_type, caption, text, embedding, created_at, storage, file_path, s3_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      doc.id,
      doc.userId,
      doc.originalName,
      doc.fileMime,
      doc.mediaType,
      doc.caption,
      doc.text,
      JSON.stringify(doc.embedding ?? []),
      doc.createdAt,
      doc.storage ?? 'local',
      doc.filePath ?? null,
      doc.s3Key ?? null,
    ],
  );

  const categories = Array.from(
    new Set((doc.categories ?? []).map((c) => canonicalizeCategory(c)).filter(Boolean)),
  ).slice(0, Math.max(1, Math.min(10, MAX_CATEGORIES_PER_DOC)));
  for (const name of categories) {
    const categoryId = await upsertCategoryId(doc.userId, name);
    await mysqlPool.execute('INSERT IGNORE INTO doc_categories (doc_id, category_id) VALUES (?, ?)', [doc.id, categoryId]);
  }
};

const deleteDocFromDb = async (userId: string, docId: string) => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  const [rows] = (await mysqlPool.execute('SELECT storage, file_path AS filePath, s3_key AS s3Key FROM docs WHERE id=? AND user_id=?', [
    docId,
    userId,
  ])) as any[];
  const row = (rows as any[])[0];
  if (!row) return null as null | { storage?: string; filePath?: string; s3Key?: string };
  await mysqlPool.execute('DELETE FROM docs WHERE id=? AND user_id=?', [docId, userId]);
  return {
    storage: row.storage ? String(row.storage) : undefined,
    filePath: row.filePath ? String(row.filePath) : undefined,
    s3Key: row.s3Key ? String(row.s3Key) : undefined,
  };
};

const renameCategoryInDb = async (userId: string, from: string, to: string) => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  const fromName = canonicalizeCategory(from);
  const toName = canonicalizeCategory(to);
  if (!fromName || !toName || fromName === toName) return 0;

  const fromIds = await resolveCategoryIdsInDb(userId, fromName);
  if (!fromIds.length) return 0;

  const toId = await upsertCategoryId(userId, toName);

  let changed = 0;
  for (const fromId of fromIds) {
    if (fromId === toId) continue;
    await mysqlPool.execute(
      'INSERT IGNORE INTO doc_categories (doc_id, category_id) SELECT doc_id, ? FROM doc_categories WHERE category_id=?',
      [toId, fromId],
    );
    await mysqlPool.execute('DELETE FROM doc_categories WHERE category_id=?', [fromId]);
    await mysqlPool.execute('DELETE FROM categories WHERE id=? AND user_id=?', [fromId, userId]);
    changed += 1;
  }
  return changed ? 1 : 0;
};

const deleteCategoryInDb = async (
  userId: string,
  name: string,
  mode: 'unlink' | 'purge' | 'unlink-delete-orphans',
) => {
  if (!mysqlPool) throw new Error('DB not configured');
  await ensureSchemaOnce();
  const categoryName = canonicalizeCategory(name);
  if (!categoryName) return { removedFrom: 0, deletedDocs: 0 };
  const categoryIds = await resolveCategoryIdsInDb(userId, categoryName);
  if (!categoryIds.length) {
    await mysqlPool.execute('DELETE FROM categories WHERE user_id=? AND name=?', [userId, categoryName]);
    return { removedFrom: 0, deletedDocs: 0 };
  }
  const cleanupMeta = async (meta: null | { filePath?: string; s3Key?: string }) => {
    if (!meta) return;
    if (meta.s3Key) {
      try {
        await deleteS3Object(meta.s3Key);
      } catch (err) {
        console.warn('Failed to delete S3 object', err);
      }
    }
    if (meta.filePath) {
      try {
        if (fs.existsSync(meta.filePath)) fs.unlinkSync(meta.filePath);
      } catch (err) {
        console.warn('Failed to delete file', err);
      }
    }
  };

  const placeholders = categoryIds.map(() => '?').join(',');
  const [docRows] = (await mysqlPool.execute(
    `SELECT DISTINCT dc.doc_id AS docId
     FROM doc_categories dc
     JOIN categories c ON c.id = dc.category_id
     WHERE c.user_id = ? AND c.id IN (${placeholders})`,
    [userId, ...categoryIds],
  )) as any[];
  const docIds = (docRows as any[]).map((r) => String(r.docId));

  if (docIds.length === 0) {
    await mysqlPool.execute(`DELETE FROM categories WHERE user_id=? AND id IN (${placeholders})`, [userId, ...categoryIds]);
    return { removedFrom: 0, deletedDocs: 0 };
  }

  const removedFrom = docIds.length;

  if (mode === 'purge') {
    let deletedDocs = 0;
    for (const docId of docIds) {
      const meta = await deleteDocFromDb(userId, docId);
      if (meta) {
        deletedDocs += 1;
        await cleanupMeta(meta);
      }
    }
    await mysqlPool.execute(`DELETE FROM categories WHERE user_id=? AND id IN (${placeholders})`, [userId, ...categoryIds]);
    return { removedFrom: 0, deletedDocs };
  }

  await mysqlPool.execute(`DELETE FROM categories WHERE user_id=? AND id IN (${placeholders})`, [userId, ...categoryIds]);

  if (mode !== 'unlink-delete-orphans') {
    return { removedFrom, deletedDocs: 0 };
  }

  const chunks: string[][] = [];
  for (let i = 0; i < docIds.length; i += 200) chunks.push(docIds.slice(i, i + 200));
  let deletedDocs = 0;
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const [orphanRows] = (await mysqlPool.execute(
      `SELECT d.id
       FROM docs d
       LEFT JOIN doc_categories dc ON dc.doc_id = d.id
       WHERE d.user_id=? AND d.id IN (${placeholders})
       GROUP BY d.id
       HAVING COUNT(dc.category_id)=0`,
      [userId, ...chunk],
    )) as any[];
    for (const row of orphanRows as any[]) {
      const docId = String(row.id);
      const meta = await deleteDocFromDb(userId, docId);
      if (meta) {
        deletedDocs += 1;
        await cleanupMeta(meta);
      }
    }
  }
  return { removedFrom, deletedDocs };
};

const listDocs = async (userId: string) => {
  if (mysqlPool) return await listDocsFromDb(userId, { includeEmbedding: false });
  return db.docs.filter((d) => d.userId === userId);
};

const listSearchableDocs = async (userId: string) => {
  if (mysqlPool) {
    const docs = await listDocsFromDb(userId, { includeEmbedding: true });
    // Exclude orphan documents (no categories) from search results
    return docs.filter((d) => d.embedding.length && d.categories.length > 0);
  }
  return db.docs.filter((d) => d.userId === userId && d.embedding.length && (d.categories?.length ?? 0) > 0);
};

const getDocById = async (userId: string, docId: string): Promise<ScreenshotDoc | null> => {
  if (mysqlPool) return await getDocByIdFromDb(userId, docId);
  const doc = db.docs.find((d) => d.userId === userId && d.id === docId);
  return doc ?? null;
};

const saveDoc = async (doc: ScreenshotDoc) => {
  if (mysqlPool) return await saveDocToDb(doc);
  db.docs.unshift(doc);
  writeDB(db);
};

const randomId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const cosine = (a: number[], b: number[]) => {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
};

const listUserCategories = async (userId: string) => {
  const limitRaw = Number.isFinite(MAX_EXISTING_CATEGORIES_CONTEXT) ? MAX_EXISTING_CATEGORIES_CONTEXT : 50;
  const limit = Math.max(0, Math.min(200, Math.floor(limitRaw)));
  if (mysqlPool) {
    await ensureSchemaOnce();
    const [rows] = (await mysqlPool.execute(
      `SELECT c.name AS name, COUNT(dc.doc_id) AS cnt
       FROM categories c
       LEFT JOIN doc_categories dc ON dc.category_id = c.id
       WHERE c.user_id=?
       GROUP BY c.id
       ORDER BY cnt DESC, c.name ASC
       LIMIT ${limit}`,
      [userId],
    )) as any[];
    return (rows as any[]).map((r) => canonicalizeCategory(String(r?.name ?? ''))).filter(Boolean);
  }

  const counts = new Map<string, number>();
  for (const doc of db.docs) {
    if (doc.userId !== userId) continue;
    for (const c of doc.categories ?? []) {
      const key = canonicalizeCategory(c);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
};

const analyzeScreenshot = async (filePath: string, mime: string, existingCategories: string[]): Promise<Analysis> => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
  const safeMime = mime?.startsWith('image/') ? mime : 'image/png';
  const safeExisting = Array.from(new Set(existingCategories.map((c) => canonicalizeCategory(c)).filter(Boolean))).slice(
    0,
    Math.max(0, Math.min(200, MAX_EXISTING_CATEGORIES_CONTEXT)),
  );
  const response = await openai.chat.completions.create({
    model: VISION_MODEL,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ScreenshotAnalysis',
        schema: {
          type: 'object',
          properties: {
            caption: { type: 'string' },
            existingCategories: { type: 'array', items: { type: 'string' } },
            newCategories: { type: 'array', items: { type: 'string' } },
            text: { type: 'array', items: { type: 'string' } },
          },
          required: ['caption', 'existingCategories', 'newCategories', 'text'],
          additionalProperties: false,
        },
        strict: true,
      },
    },
    messages: [
      {
        role: 'system',
        content:
          'You summarize screenshots and categorize them. Extract on-screen text accurately. Choose exactly 1 category per screenshot, preferring an existing category when it fits.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Return JSON with caption, existingCategories, newCategories, text array.\n' +
              'Rules:\n' +
              '- Prefer the provided existing categories when a screenshot fits.\n' +
              '- Output exactly 1 category total.\n' +
              '- If a provided category fits, set existingCategories to a 1-item array (picked verbatim) and set newCategories to an empty array.\n' +
              '- If none fit, set existingCategories to an empty array and set newCategories to a 1-item array.\n' +
              '- The chosen category should be stable and reusable (not overly specific).\n' +
              '- Never include numbers, ids, timestamps, or list indices in categories.\n' +
              `Existing categories: ${JSON.stringify(safeExisting)}\n`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${safeMime};base64,${base64}`,
            },
          },
        ],
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error('No analysis content returned');
  return JSON.parse(content) as Analysis;
};

let pdfParseLoader: Promise<any> | null = null;
const loadPdfParse = async () => {
  if (pdfParseLoader) return pdfParseLoader;
  pdfParseLoader = import('pdf-parse')
    .then((m) => m?.default ?? m)
    .catch(() => null);
  return pdfParseLoader;
};

let mammothLoader: Promise<any> | null = null;
const loadMammoth = async () => {
  if (mammothLoader) return mammothLoader;
  mammothLoader = import('mammoth')
    .then((m) => m?.default ?? m)
    .catch(() => null);
  return mammothLoader;
};

const extractTextFromPdf = async (filePath: string) => {
  const parser = await loadPdfParse();
  if (!parser) throw new Error('pdf-parse is not available');
  const data = await parser(fs.readFileSync(filePath));
  return String(data?.text ?? '').trim();
};

const extractTextFromDocx = async (filePath: string) => {
  const mammoth = await loadMammoth();
  if (!mammoth) throw new Error('mammoth is not available');
  const result = await mammoth.extractRawText({ path: filePath });
  return String(result?.value ?? '').trim();
};

const isTextDocMime = (mime: string) =>
  mime.startsWith('text/') ||
  mime === 'application/rtf' ||
  mime === 'application/pdf' ||
  mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const analyzeDocumentText = async (
  text: string,
  filename: string,
  existingCategories: string[],
): Promise<Analysis> => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const safeExisting = Array.from(new Set(existingCategories.map((c) => canonicalizeCategory(c)).filter(Boolean))).slice(
    0,
    Math.max(0, Math.min(200, MAX_EXISTING_CATEGORIES_CONTEXT)),
  );
  const snippet = String(text ?? '').slice(0, Math.max(0, DOC_TEXT_ANALYSIS_MAX_CHARS));
  const response = await openai.chat.completions.create({
    model: VISION_MODEL,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'DocumentAnalysis',
        schema: {
          type: 'object',
          properties: {
            caption: { type: 'string' },
            existingCategories: { type: 'array', items: { type: 'string' } },
            newCategories: { type: 'array', items: { type: 'string' } },
            text: { type: 'array', items: { type: 'string' } },
          },
          required: ['caption', 'existingCategories', 'newCategories', 'text'],
          additionalProperties: false,
        },
        strict: true,
      },
    },
    messages: [
      {
        role: 'system',
        content:
          'You summarize documents and categorize them. Use the document text to pick a stable category.',
      },
      {
        role: 'user',
        content:
          'Return JSON with caption, existingCategories, newCategories, text array.\n' +
          'Rules:\n' +
          '- Prefer the provided existing categories when a document fits.\n' +
          '- Output exactly 1 category total.\n' +
          '- If a provided category fits, set existingCategories to a 1-item array (picked verbatim) and set newCategories to an empty array.\n' +
          '- If none fit, set existingCategories to an empty array and set newCategories to a 1-item array.\n' +
          '- The chosen category should be stable and reusable (not overly specific).\n' +
          '- Never include numbers, ids, timestamps, or list indices in categories.\n' +
          `Filename: ${filename}\n` +
          `Existing categories: ${JSON.stringify(safeExisting)}\n` +
          `Document text:\n${snippet}`,
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error('No analysis content returned');
  return JSON.parse(content) as Analysis;
};

const embedText = async (text: string) => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const result = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return result.data?.[0]?.embedding ?? [];
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const clampInt = (n: unknown, min: number, max: number) => clamp(Number(n || 0) | 0, min, max);
const truncate = (text: string, maxChars: number) => {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
};
const tokenize = (text: string) => {
  const tokens = String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g);
  return Array.from(new Set(tokens ?? [])).slice(0, 40);
};

const buildRetrievalContext = async (
  query: string,
  topK: number,
  userId: string,
  opts?: { category?: string | null; docId?: string | null },
) => {
  const requestedTopK = clampInt(topK, 1, RAG_TOPK_MAX);
  const categoryKey = opts?.category ? canonicalizeCategory(opts.category) : '';
  const docId = String(opts?.docId ?? '').trim();
  if (docId) {
    const doc = await getDocById(userId, docId);
    if (!doc) {
      return { context: '', ranked: [] as { doc: ScreenshotDoc; score: number }[], reason: 'Document not found.' };
    }
    const queryEmbedding = await embedText(query);
    const queryTokens = tokenize(query);
    const cosineScore = cosine(queryEmbedding, doc.embedding);
    const docBlob = `${doc.caption}\n${(doc.categories ?? []).join(' ')}\n${doc.text}`;
    const docTokens = tokenize(docBlob);
    const overlap =
      queryTokens.length === 0 ? 0 : queryTokens.filter((t) => docTokens.includes(t)).length / queryTokens.length;
    const hybrid = cosineScore + RAG_LEXICAL_WEIGHT * overlap;
    const ranked = [{ doc, score: hybrid, cosine: cosineScore, overlap }];
    const context = ranked
      .map(({ doc, score, cosine, overlap }) => {
        const caption = truncate(doc.caption, RAG_DOC_CAPTION_MAX_CHARS);
        const text = truncate(doc.text, RAG_DOC_TEXT_MAX_CHARS);
        const cats = (doc.categories ?? []).map((c) => canonicalizeCategory(c)).filter(Boolean).join(', ');
        return `score:${score.toFixed(3)} cos:${cosine.toFixed(3)} lex:${overlap.toFixed(2)} | caption:${caption} | categories:${cats} | text:${text}`;
      })
      .join('\n');
    return { context, ranked };
  }

  const searchableAll = await listSearchableDocs(userId);
  if (!searchableAll.length) {
    return { context: '', ranked: [] as { doc: ScreenshotDoc; score: number }[], reason: 'No items indexed yet.' };
  }
  const searchable = categoryKey
    ? searchableAll.filter((d) => (d.categories ?? []).some((c) => canonicalizeCategory(c) === categoryKey))
    : searchableAll;
  if (!searchable.length) {
    return {
      context: '',
      ranked: [] as { doc: ScreenshotDoc; score: number }[],
      reason: categoryKey ? `No items found in “${categoryKey}”.` : 'No items indexed yet.',
    };
  }
  const queryEmbedding = await embedText(query);
  const queryTokens = tokenize(query);
  const ranked = searchable
    .map((doc) => {
      const cosineScore = cosine(queryEmbedding, doc.embedding);
      const docBlob = `${doc.caption}\n${(doc.categories ?? []).join(' ')}\n${doc.text}`;
      const docTokens = tokenize(docBlob);
      const overlap =
        queryTokens.length === 0 ? 0 : queryTokens.filter((t) => docTokens.includes(t)).length / queryTokens.length;
      const hybrid = cosineScore + RAG_LEXICAL_WEIGHT * overlap;
      return { doc, score: hybrid, cosine: cosineScore, overlap };
    })
    .filter((r) => r.cosine >= RAG_MIN_COSINE || r.overlap >= 0.34)
    .filter((r) => r.score >= RAG_MIN_HYBRID_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, requestedTopK);

  if (!ranked.length) {
    return {
      context: '',
      ranked: [] as { doc: ScreenshotDoc; score: number }[],
      reason: 'No relevant screenshots found for that question.',
    };
  }

  const context = ranked
    .map(({ doc, score, cosine, overlap }) => {
      const caption = truncate(doc.caption, RAG_DOC_CAPTION_MAX_CHARS);
      const text = truncate(doc.text, RAG_DOC_TEXT_MAX_CHARS);
      const cats = (doc.categories ?? []).map((c) => canonicalizeCategory(c)).filter(Boolean).join(', ');
      return `score:${score.toFixed(3)} cos:${cosine.toFixed(3)} lex:${overlap.toFixed(2)} | caption:${caption} | categories:${cats} | text:${text}`;
    })
    .join('\n');

  return { context, ranked };
};

let sharpLoader: Promise<any> | null = null;
const loadSharp = async () => {
  if (sharpLoader) return sharpLoader;
  sharpLoader = import('sharp')
    .then((m) => m?.default ?? m)
    .catch(() => null);
  return sharpLoader;
};

const convertImageToPng = async (filePath: string, mime: string) => {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = mime.startsWith('image/');
  if (!isImage) return { filePath, converted: false };
  if (ext === '.png') return { filePath, converted: false };

  // First try sharp (fast path when libvips has HEIC support)
  const pngPath = `${filePath}.png`;
  try {
    const sharp = await loadSharp();
    if (!sharp) throw new Error('sharp unavailable');
    await sharp(filePath).png().toFile(pngPath);
    fs.unlinkSync(filePath);
    return { filePath: pngPath, converted: true };
  } catch (err) {
    const isHeic = ext === '.heic' || ext === '.heif' || mime.includes('heic') || mime.includes('heif');
    // Fallback: on macOS, use `sips` to convert HEIC->PNG if available
    if (isHeic && process.platform === 'darwin') {
      try {
        execFileSync('sips', ['-s', 'format', 'png', filePath, '--out', pngPath], { stdio: 'ignore' });
        fs.unlinkSync(filePath);
        return { filePath: pngPath, converted: true };
      } catch (sipsErr) {
        throw new Error(
          'HEIC conversion failed. Install libvips with HEIC support or ensure `sips` is available on macOS.',
        );
      }
    }
    return { filePath, converted: false };
  }
};

const signGetUrl = async (key: string) => {
  if (!s3 || !S3_BUCKET) return null;
  try {
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), {
      expiresIn: S3_URL_EXPIRES_SECONDS,
    });
  } catch (err) {
    console.warn('Failed to presign S3 URL', err);
    return null;
  }
};

const resolveDocUri = async (doc: ScreenshotDoc) => {
  if (doc.storage === 's3' && doc.s3Key) {
    const signed = await signGetUrl(doc.s3Key);
    if (signed) return signed;
  }
  if (doc.filePath) return `/uploads/${path.basename(doc.filePath)}`;
  return null;
};

const toPublicDoc = async (doc: ScreenshotDoc) => {
  const uri = await resolveDocUri(doc);
  const { embedding: _omit, ...rest } = doc;
  return { ...rest, uri };
};

const deleteS3Object = async (key: string) => {
  if (!s3 || !S3_BUCKET) return;
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
};

const uploadToS3 = async (userId: string, docId: string, filePath: string, contentType: string) => {
  if (!s3 || !S3_BUCKET) return null;
  const ext = path.extname(filePath) || (contentType.startsWith('image/') ? '.png' : '');
  const safeExt = ext && ext.length <= 8 ? ext : '';
  const key = `users/${userId}/uploads/${docId}${safeExt}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
    }),
  );
  return key;
};

app.get('/', (_req, res) => {
  res.status(200).send('ok');
});

app.get('/api/health', async (_req, res) => {
  let dbOk = false;
  if (mysqlPool) {
    try {
      await mysqlPool.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
  }
  res.json({
    ok: true,
    db: {
      configured: !!mysqlPool,
      ok: dbOk,
      host: DB_HOST ? String(DB_HOST) : null,
      name: DB_NAME ? String(DB_NAME) : null,
    },
    s3: {
      configured: !!(s3 && S3_BUCKET),
      bucket: S3_BUCKET ?? null,
      region: AWS_REGION,
    },
  });
});

app.post('/api/auth/prepare', async (req, res) => {
  const provider = String((req.body as any)?.provider ?? '').trim().toLowerCase();
  if (provider !== 'apple') {
    return res.status(400).json({ error: 'Unsupported provider' });
  }
  res.json({
    ok: true,
    provider,
    audience: APPLE_AUDIENCE || null,
  });
});

app.post('/api/auth/verify', async (req, res) => {
  const provider = String((req.body as any)?.provider ?? '').trim().toLowerCase();
  if (provider !== 'apple') {
    return res.status(400).json({ error: 'Unsupported provider' });
  }
  const identityToken = String((req.body as any)?.identityToken ?? '').trim();
  if (!identityToken) return res.status(400).json({ error: 'identityToken is required' });
  try {
    const payload = await verifyAppleIdentityToken(identityToken);
    const sub = String(payload.sub ?? '').trim();
    if (!sub) return res.status(400).json({ error: 'Invalid Apple token' });
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const fullName = (req.body as any)?.fullName as { givenName?: string; familyName?: string } | undefined;
    const displayName = [fullName?.givenName, fullName?.familyName].filter(Boolean).join(' ').trim() || undefined;
    const userId = `apple_${sub}`;
    await updateUserProfile(userId, {
      provider: 'apple',
      providerSub: sub,
      email,
      displayName,
    });
    return res.json({
      ok: true,
      provider: 'apple',
      userId,
      user: {
        id: userId,
        email: email ?? null,
        displayName: displayName ?? null,
      },
    });
  } catch (err: any) {
    console.error('Apple verify failed', err);
    return res.status(401).json({ error: err?.message ?? 'Invalid Apple token' });
  }
});

app.post('/api/auth/refresh', async (_req, res) => {
  res.json({
    ok: false,
    status: 'disabled',
    message: 'Auth is not configured yet.',
  });
});

app.get('/api/me', async (req, res) => {
  let userId = 'public';
  try {
    userId = getUserIdFromHeader(req);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
  try {
    const user = await getUserRecord(userId);
    const entitlement = await getEntitlement(userId);
    const effectivePlan = resolveEffectivePlan(entitlement);
    const usageDay = getUtcDay();
    const usageDaily = await getUsageDaily(userId, usageDay);
    const usageTotals = await getUsageTotals(userId);
    res.json({
      user,
      entitlement,
      effectivePlan,
      limits: PLAN_LIMITS[effectivePlan],
      usage: {
        day: usageDay,
        messagesUsed: usageDaily.messagesUsed,
        uploadsTotal: usageTotals.uploadsTotal,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Failed to load profile' });
  }
});

app.get('/api/docs', async (req, res) => {
  try {
    const userId = getUserIdFromHeader(req);
    const docs = await listDocs(userId);
    const publicDocs = await Promise.all(docs.map(toPublicDoc));
    res.json({ docs: publicDocs });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const userId = getUserIdFromHeader(req);
    const map: Record<string, number> = {};
    const docs = await listDocs(userId);
    docs.forEach((doc) => {
      doc.categories.forEach((c) => {
        const key = canonicalizeCategory(c);
        if (!key) return;
        map[key] = (map[key] ?? 0) + 1;
      });
    });
    const categories = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
    res.json({ categories });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
});

app.delete('/api/docs/:id', (req, res) => {
  let userId = 'public';
  try {
    userId = getUserIdFromHeader(req);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
  const id = req.params.id;
  const deleteLocal = (filePath?: string) => {
    if (!filePath) return;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('Failed to delete file', err);
    }
  };

  (async () => {
    try {
      if (mysqlPool) {
        const meta = await deleteDocFromDb(userId, id);
        if (!meta) return res.status(404).json({ error: 'not found' });
        if (meta.s3Key) {
          try {
            await deleteS3Object(meta.s3Key);
          } catch (err) {
            console.warn('Failed to delete S3 object', err);
          }
        }
        deleteLocal(meta.filePath);
        return res.json({ ok: true });
      }

      const idx = db.docs.findIndex((d) => d.id === id && d.userId === userId);
      if (idx === -1) return res.status(404).json({ error: 'not found' });
      const [doc] = db.docs.splice(idx, 1);
      if (doc?.s3Key) {
        try {
          await deleteS3Object(doc.s3Key);
        } catch (err) {
          console.warn('Failed to delete S3 object', err);
        }
      }
      deleteLocal(doc?.filePath);
      writeDB(db);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error('Delete failed', err);
      return res.status(500).json({ error: err?.message ?? 'Delete failed' });
    }
  })();
});

app.delete('/api/categories/:name', async (req, res) => {
  let userId = 'public';
  try {
    userId = getUserIdFromHeader(req);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
  const raw = req.params.name ?? '';
  let name = canonicalizeCategory(raw);
  try {
    name = canonicalizeCategory(decodeURIComponent(raw));
  } catch {
    // ignore malformed encoding; use raw param
  }
  const mode = String(req.query.mode ?? 'unlink').toLowerCase(); // unlink | purge | unlink-delete-orphans
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!['unlink', 'purge', 'unlink-delete-orphans'].includes(mode)) {
    return res.status(400).json({ error: 'invalid mode' });
  }

  if (mysqlPool) {
    try {
      const result = await deleteCategoryInDb(userId, name, mode as any);
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error('Delete category failed', err);
      return res.status(500).json({ error: err?.message ?? 'Delete category failed' });
    }
  }

  let removedFrom = 0;
  let deletedDocs = 0;

  const keep: ScreenshotDoc[] = [];
  for (const doc of db.docs) {
    if (doc.userId !== userId) {
      keep.push(doc);
      continue;
    }
    const before = doc.categories ?? [];
    const has = before.some((c) => canonicalizeCategory(c) === name);
    if (!has) {
      keep.push(doc);
      continue;
    }

    if (mode === 'purge') {
      deletedDocs += 1;
      if (doc?.s3Key) {
        try {
          await deleteS3Object(doc.s3Key);
        } catch (err) {
          console.warn('Failed to delete S3 object', err);
        }
      }
      try {
        if (doc?.filePath && fs.existsSync(doc.filePath)) {
          fs.unlinkSync(doc.filePath);
        }
      } catch (err) {
        console.warn('Failed to delete file', err);
      }
      continue;
    }

    const nextCategories = before.filter((c) => canonicalizeCategory(c) !== name);
    removedFrom += 1;

    if (mode === 'unlink-delete-orphans' && nextCategories.length === 0) {
      deletedDocs += 1;
      if (doc?.s3Key) {
        try {
          await deleteS3Object(doc.s3Key);
        } catch (err) {
          console.warn('Failed to delete S3 object', err);
        }
      }
      try {
        if (doc?.filePath && fs.existsSync(doc.filePath)) {
          fs.unlinkSync(doc.filePath);
        }
      } catch (err) {
        console.warn('Failed to delete file', err);
      }
      continue;
    }

    keep.push({
      ...doc,
      categories: Array.from(new Set(nextCategories.map((c) => canonicalizeCategory(c)).filter(Boolean))),
    });
  }

  db.docs = keep;
  writeDB(db);
  res.json({
    ok: true,
    removedFrom,
    deletedDocs,
    remaining: db.docs.filter((d) => d.userId === userId).length,
  });
});

app.patch('/api/categories/:name', async (req, res) => {
  let userId = 'public';
  try {
    userId = getUserIdFromHeader(req);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
  const raw = req.params.name ?? '';
  let fromName = canonicalizeCategory(raw);
  try {
    fromName = canonicalizeCategory(decodeURIComponent(raw));
  } catch {
    // ignore malformed encoding; use raw param
  }

  const toRaw = String((req.body as any)?.to ?? '').trim();
  const toName = canonicalizeCategory(toRaw);

  if (!fromName) return res.status(400).json({ error: 'name is required' });
  if (!toName) return res.status(400).json({ error: 'to is required' });
  if (toName === fromName) return res.json({ ok: true, changed: 0 });

  if (mysqlPool) {
    try {
      const changed = await renameCategoryInDb(userId, fromName, toName);
      return res.json({ ok: true, changed });
    } catch (err: any) {
      console.error('Rename failed', err);
      return res.status(500).json({ error: err?.message ?? 'Rename failed' });
    }
  }

  let changed = 0;
  db.docs = db.docs.map((doc) => {
    if (doc.userId !== userId) return doc;
    const before = doc.categories ?? [];
    const has = before.some((c) => canonicalizeCategory(c) === fromName);
    if (!has) return doc;

    const renamed = before.map((c) => (canonicalizeCategory(c) === fromName ? toName : c));
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const c of renamed) {
      const key = canonicalizeCategory(c);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(key);
    }
    changed += 1;
    return { ...doc, categories: deduped };
  });

  writeDB(db);
  res.json({ ok: true, changed });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  let userId = 'public';
  try {
    userId = getUserIdFromHeader(req);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }
  const createdAt = Number(req.body.createdAt) || Date.now();
  const originalName = req.file.originalname;
  let fileMime = req.file.mimetype || 'application/octet-stream';
  const ext = path.extname(originalName).toLowerCase();
  const inferMimeFromExt = (extension: string) => {
    if (extension === '.pdf') return 'application/pdf';
    if (extension === '.txt') return 'text/plain';
    if (extension === '.md') return 'text/markdown';
    if (extension === '.rtf') return 'application/rtf';
    if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return '';
  };
  if (fileMime === 'application/octet-stream') {
    const inferred = inferMimeFromExt(ext);
    if (inferred) fileMime = inferred;
  }
  const isImage = fileMime.startsWith('image/');
  const isVideo = fileMime.startsWith('video/');
  const isDoc = isTextDocMime(fileMime);

  if (isVideo) {
    try {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch {
      // ignore
    }
    return res.status(400).json({ error: 'Videos are not supported. Please upload screenshots (photos) only.' });
  }

  if (!isImage && !isDoc) {
    try {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch {
      // ignore
    }
    return res.status(400).json({ error: 'Only images, PDFs, and text documents are supported.' });
  }

  const uploadAllowance = await checkUploadAllowance(userId);
  if (!uploadAllowance.allowed) {
    try {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch {
      // ignore
    }
    return res.status(402).json(buildPaywallPayload('uploads', uploadAllowance.used, uploadAllowance.limit, uploadAllowance.plan));
  }

  try {
    let doc: ScreenshotDoc;

    if (isImage) {
      const { filePath: usablePath, converted } = await convertImageToPng(req.file.path, fileMime);
      const existingCategories = await listUserCategories(userId);
      const analysis = await analyzeScreenshot(usablePath, converted ? 'image/png' : fileMime, existingCategories);
      const combinedText = [analysis.caption, ...(analysis.text ?? [])].join('\n');
      const embedding = await embedText(combinedText);
      const id = randomId();
      const existingSet = new Set(existingCategories.map((c) => canonicalizeCategory(c)).filter(Boolean));
      const pickedExisting = (analysis.existingCategories ?? [])
        .map((c) => canonicalizeCategory(c))
        .filter((c) => !!c && existingSet.has(c));
      const pickedNew = (analysis.newCategories ?? [])
        .map((c) => canonicalizeCategory(c))
        .filter((c) => !!c && !existingSet.has(c));
      const chosen = pickedExisting[0] || pickedNew[0] || 'unsorted';
      const categories = [chosen].slice(0, Math.max(1, Math.min(10, MAX_CATEGORIES_PER_DOC)));

      doc = {
        id,
        userId,
        filePath: usablePath,
        originalName: converted
          ? originalName.replace(/\.[^.]+$/i, '.png')
          : originalName,
        fileMime: converted ? 'image/png' : fileMime,
        mediaType: 'image',
        caption: analysis.caption || 'Screenshot',
        categories,
        text: (analysis.text ?? []).join(' '),
        embedding,
        createdAt,
      };
    } else {
      const existingCategories = await listUserCategories(userId);
      let extractedText = '';
      try {
        if (fileMime === 'application/pdf') {
          extractedText = await extractTextFromPdf(req.file.path);
        } else if (fileMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          extractedText = await extractTextFromDocx(req.file.path);
        } else if (fileMime.startsWith('text/') || fileMime === 'application/rtf') {
          extractedText = fs.readFileSync(req.file.path, 'utf-8');
        }
      } catch (err) {
        console.warn('Document text extraction failed', err);
      }

      const analysis = await analyzeDocumentText(extractedText, originalName, existingCategories);
      const combinedText = [
        analysis.caption,
        ...(analysis.text ?? []),
        extractedText.slice(0, Math.max(0, DOC_TEXT_EMBED_MAX_CHARS)),
      ].join('\n');
      const embedding = await embedText(combinedText);
      const id = randomId();
      const existingSet = new Set(existingCategories.map((c) => canonicalizeCategory(c)).filter(Boolean));
      const pickedExisting = (analysis.existingCategories ?? [])
        .map((c) => canonicalizeCategory(c))
        .filter((c) => !!c && existingSet.has(c));
      const pickedNew = (analysis.newCategories ?? [])
        .map((c) => canonicalizeCategory(c))
        .filter((c) => !!c && !existingSet.has(c));
      const chosen = pickedExisting[0] || pickedNew[0] || 'unsorted';
      const categories = [chosen].slice(0, Math.max(1, Math.min(10, MAX_CATEGORIES_PER_DOC)));

      doc = {
        id,
        userId,
        filePath: req.file.path,
        originalName,
        fileMime,
        mediaType: 'document',
        caption: analysis.caption || 'Document',
        categories,
        text: truncate(extractedText || analysis.text?.join(' ') || '', DOC_TEXT_STORE_MAX_CHARS),
        embedding,
        createdAt,
      };
    }

    doc.storage = 'local';
    if (s3 && S3_BUCKET && doc.filePath) {
      try {
        const key = await uploadToS3(userId, doc.id, doc.filePath, doc.fileMime);
        if (key) {
          doc.storage = 's3';
          doc.s3Key = key;
          try {
            if (fs.existsSync(doc.filePath)) fs.unlinkSync(doc.filePath);
          } catch (err) {
            console.warn('Failed to delete local upload after S3 put', err);
          }
          doc.filePath = undefined;
        }
      } catch (err) {
        console.warn('S3 upload failed (falling back to local storage)', err);
        doc.storage = 'local';
      }
    }

    await saveDoc(doc);
    await incrementUploadsTotal(userId, 1);
    res.json({ doc: await toPublicDoc(doc) });
  } catch (err: any) {
    console.error('Upload failed', err);
    res.status(500).json({ error: err?.message ?? 'Upload failed' });
  }
});

app.post('/api/search', async (req, res) => {
  const { query, topK = 5, category, model, docId } = req.body as {
    query?: string;
    topK?: number;
    category?: string;
    model?: string;
    docId?: string;
  };
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  let userId = 'public';
  try {
    userId = getUserIdFromHeader(req);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Invalid request' });
  }
  try {
    const allowance = await checkMessageAllowance(userId);
    if (!allowance.allowed) {
      return res.status(402).json(buildPaywallPayload('messages', allowance.used, allowance.limit, allowance.plan));
    }
    await incrementUsageDaily(userId, allowance.day, 1);
    const { context, ranked, reason } = await buildRetrievalContext(query, topK, userId, {
      category,
      docId,
    });
    if (!ranked.length) return res.json({ answer: reason || 'No items indexed yet.', matches: [] });
    const openaiClient = requireOpenAI();

    const response = await openaiClient.chat.completions.create({
      model: resolveChatModel(model),
      messages: [
        {
          role: 'system',
          content:
            'You are a retrieval assistant. Use only the provided screenshot context to answer briefly. If context is irrelevant or insufficient, say so.',
        },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
      ],
    });

    const answer =
      response.choices?.[0]?.message?.content ??
      'No response returned. Try again.';
    const matchesRaw = await Promise.all(
      ranked.map(async ({ doc, score }) => ({
        ...(await toPublicDoc(doc)),
        score,
      })),
    );
    const matches = dedupeMatches(matchesRaw);
    res.json({
      answer,
      matches,
    });
  } catch (err: any) {
    console.error('Search failed', err);
    res.status(500).json({ error: err?.message ?? 'Search failed' });
  }
});

app.post('/api/search-stream', async (req, res) => {
  const { query, topK = 5, category, model, docId } = req.body as {
    query?: string;
    topK?: number;
    category?: string;
    model?: string;
    docId?: string;
  };
  if (!query || !query.trim()) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  let userId = 'public';
  try {
    userId = getUserIdFromHeader(req);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? 'Invalid request' });
    return;
  }

  const allowance = await checkMessageAllowance(userId);
  if (!allowance.allowed) {
    res.status(402).json(buildPaywallPayload('messages', allowance.used, allowance.limit, allowance.plan));
    return;
  }

  // Prepare SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.socket?.setNoDelay(true);

  // Kickstart the stream and keep intermediaries from buffering
  res.write(':\n\n');
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': ping\n\n');
  }, 15000);

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  req.on('aborted', abort);
  res.on('close', () => {
    if (!res.writableEnded) abort();
  });
  res.on('close', () => clearInterval(heartbeat));
  res.on('finish', () => clearInterval(heartbeat));

  try {
    await incrementUsageDaily(userId, allowance.day, 1);
    const { context, ranked, reason } = await buildRetrievalContext(query, topK, userId, {
      category,
      docId,
    });
    if (!ranked.length) {
      writeSse(res, { type: 'info', message: reason || 'No items indexed yet.' });
      writeSse(res, { type: 'done' });
      res.end();
      return;
    }

    // Send matches upfront
    const matchesRaw = await Promise.all(
      ranked.map(async ({ doc, score }) => ({
        ...(await toPublicDoc(doc)),
        score,
      })),
    );
    const matches = dedupeMatches(matchesRaw);
    writeSse(res, { type: 'matches', matches });

    const openaiClient = requireOpenAI();
    const stream = await openaiClient.chat.completions.create(
      {
        model: resolveChatModel(model),
        stream: true,
        messages: [
          {
            role: 'system',
            content:
              'You are a retrieval assistant. Use only the provided screenshot context to answer briefly. If context is irrelevant or insufficient, say so.',
          },
          { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
        ],
      },
      { signal: controller.signal },
    );

    for await (const part of stream) {
      const deltaContent = part.choices?.[0]?.delta?.content;
      if (typeof deltaContent !== 'string' || !deltaContent) continue;
      writeSse(res, { type: 'chunk', text: deltaContent });
    }

    writeSse(res, { type: 'done' });
    res.end();
  } catch (err: any) {
    console.error('Search stream failed', err);
    const message = err?.message ?? 'Search failed';
    const isAbort =
      controller.signal.aborted ||
      err?.name === 'AbortError' ||
      (typeof message === 'string' && /aborted|abort/i.test(message));
    if (!isAbort) {
      writeSse(res, { type: 'error', message });
    }
    res.end();
  }
});

const server = createServer(app);

const wsSend = (ws: import('ws').WebSocket, data: unknown) => {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(data));
};

const dedupeMatches = <T extends { id?: string; uri?: string | null; score?: number }>(items: T[]) => {
  const bestByKey = new Map<string, T>();
  for (const item of items) {
    const idKey = String(item?.id ?? '').trim();
    const uriKey = String(item?.uri ?? '').trim();
    const key = idKey || uriKey;
    if (!key) continue;
    const prev = bestByKey.get(key);
    if (!prev) {
      bestByKey.set(key, item);
      continue;
    }
    const prevScore = Number(prev.score ?? 0);
    const nextScore = Number(item.score ?? 0);
    if (nextScore > prevScore) bestByKey.set(key, item);
  }
  const out = Array.from(bestByKey.values());
  out.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
  return out;
};

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  let activeController: AbortController | null = null;

  const abortActive = () => {
    if (activeController && !activeController.signal.aborted) activeController.abort();
    activeController = null;
  };

  ws.on('close', abortActive);
  ws.on('error', abortActive);

  ws.on('message', async (raw) => {
    let message: any;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      message = JSON.parse(text);
    } catch {
      wsSend(ws, { type: 'error', message: 'Invalid JSON message' });
      return;
    }

    if (message?.type !== 'search') {
      wsSend(ws, { type: 'error', message: 'Unknown message type' });
      return;
    }

    const query = typeof message?.query === 'string' ? message.query.trim() : '';
    const topK = typeof message?.topK === 'number' ? message.topK : 5;
    const category =
      typeof message?.category === 'string' && message.category.trim().length <= 80 ? message.category.trim() : '';
    const docIdRaw = typeof message?.docId === 'string' ? message.docId.trim() : '';
    const docId = docIdRaw && /^[a-zA-Z0-9_-]{3,128}$/.test(docIdRaw) ? docIdRaw : '';
    const model = resolveChatModel(message?.model);
    const userIdRaw = typeof message?.userId === 'string' ? message.userId.trim() : '';
    const userId = userIdRaw && /^[a-zA-Z0-9_-]{3,128}$/.test(userIdRaw) ? userIdRaw : 'public';
    if (!query) {
      wsSend(ws, { type: 'error', message: 'query is required' });
      return;
    }

    abortActive();
    activeController = new AbortController();

    try {
      const allowance = await checkMessageAllowance(userId);
      if (!allowance.allowed) {
        wsSend(ws, { type: 'error', ...buildPaywallPayload('messages', allowance.used, allowance.limit, allowance.plan) });
        return;
      }
      await incrementUsageDaily(userId, allowance.day, 1);
      const { context, ranked, reason } = await buildRetrievalContext(query, topK, userId, {
        category,
        docId,
      });
      if (!ranked.length) {
        wsSend(ws, { type: 'info', message: reason || 'No items indexed yet.' });
        wsSend(ws, { type: 'done' });
        return;
      }

      const matches = await Promise.all(
        ranked.map(async ({ doc, score }) => ({
          ...(await toPublicDoc(doc)),
          score,
        })),
      );
      wsSend(ws, { type: 'matches', matches: dedupeMatches(matches) });

      const openaiClient = requireOpenAI();
      const stream = await openaiClient.chat.completions.create(
        {
          model,
          stream: true,
          messages: [
            {
              role: 'system',
              content:
                'You are a retrieval assistant. Use only the provided screenshot context to answer briefly. If context is irrelevant or insufficient, say so.',
            },
            { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
          ],
        },
        { signal: activeController.signal },
      );

      for await (const part of stream) {
        const deltaContent = part.choices?.[0]?.delta?.content;
        if (typeof deltaContent !== 'string' || !deltaContent) continue;
        wsSend(ws, { type: 'chunk', text: deltaContent });
      }

      wsSend(ws, { type: 'done' });
    } catch (err: any) {
      const messageText = err?.message ?? 'Search failed';
      const isAbort =
        activeController?.signal.aborted ||
        err?.name === 'AbortError' ||
        (typeof messageText === 'string' && /aborted|abort/i.test(messageText));
      if (!isAbort) {
        wsSend(ws, { type: 'error', message: messageText });
      }
    } finally {
      activeController = null;
    }
  });

  // Keep-alive for some proxies
  const pingInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.ping();
  }, 30000);
  ws.on('close', () => clearInterval(pingInterval));
});

const start = async () => {
  if (mysqlPool && (DB_AUTO_MIGRATE || DB_ENSURE_SCHEMA)) {
    try {
      await ensureSchemaOnce();
      console.log('DB schema ensured.');
    } catch (err) {
      console.error('DB schema ensure failed (continuing to start web):', err);
    }
  }
  server.listen(PORT, () => {
    console.log(`API ready on http://localhost:${PORT}`);
    console.log(`WS ready on ws://localhost:${PORT}/ws`);
    console.log(`RDS: ${mysqlPool ? 'enabled' : 'disabled'}`);
    console.log(`S3: ${s3 && S3_BUCKET ? `enabled (${S3_BUCKET})` : 'disabled'}`);
  });
};

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
