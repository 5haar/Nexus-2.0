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
  categories: string[];
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
  mediaType: 'image' | 'video' | 'other';
  caption: string;
  categories: string[];
  text: string;
  embedding: number[];
  createdAt: number;
};

type StoredData = {
  docs: ScreenshotDoc[];
};

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VISION_MODEL = 'gpt-5.2';
const EMBED_MODEL = 'text-embedding-3-small';

if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY is not set. Vision and search will fail.');
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const requireOpenAI = () => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  return openai;
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
  limits: { fileSize: 10 * 1024 * 1024 },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(uploadsDir));

const readDB = (): StoredData => {
  if (!fs.existsSync(dbPath)) return { docs: [] };
  try {
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredData;
    parsed.docs = (parsed.docs ?? []).map((doc: any) => ({
      ...doc,
      userId: typeof doc?.userId === 'string' && doc.userId.trim() ? doc.userId.trim() : 'public',
    }));
    return parsed;
  } catch (err) {
    console.warn('Failed to read db file', err);
    return { docs: [] };
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
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
  );
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
};

const normalizeCategory = (value: string) => value.trim().toLowerCase();

const ensureUserRow = async (userId: string) => {
  if (!mysqlPool) return;
  await mysqlPool.execute('INSERT IGNORE INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
};

const upsertCategoryId = async (userId: string, name: string) => {
  if (!mysqlPool) throw new Error('DB not configured');
  const normalized = normalizeCategory(name);
  const [result] = (await mysqlPool.execute(
    'INSERT INTO categories (user_id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',
    [userId, normalized],
  )) as any;
  return Number(result.insertId) as number;
};

const listDocsFromDb = async (userId: string, opts?: { includeEmbedding?: boolean }): Promise<ScreenshotDoc[]> => {
  if (!mysqlPool) throw new Error('DB not configured');
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
      GROUP_CONCAT(c.name ORDER BY c.name SEPARATOR '\\u0001') AS categories
    FROM docs d
    LEFT JOIN doc_categories dc ON dc.doc_id = d.id
    LEFT JOIN categories c ON c.id = dc.category_id
    WHERE d.user_id = ?
    GROUP BY d.id
    ORDER BY d.created_at DESC`,
    [userId],
  )) as any[];

  return (rows as any[]).map((row) => {
    const catsRaw: string =
      typeof row.categories === 'string' ? row.categories : row.categories == null ? '' : String(row.categories);
    const categories = catsRaw
      ? catsRaw
          .split('\u0001')
          .map((c: string) => normalizeCategory(c))
          .filter(Boolean)
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

const saveDocToDb = async (doc: ScreenshotDoc) => {
  if (!mysqlPool) throw new Error('DB not configured');
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

  const categories = (doc.categories ?? []).map(normalizeCategory).filter(Boolean).slice(0, 5);
  for (const name of categories) {
    const categoryId = await upsertCategoryId(doc.userId, name);
    await mysqlPool.execute('INSERT IGNORE INTO doc_categories (doc_id, category_id) VALUES (?, ?)', [doc.id, categoryId]);
  }
};

const deleteDocFromDb = async (userId: string, docId: string) => {
  if (!mysqlPool) throw new Error('DB not configured');
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
  const fromName = normalizeCategory(from);
  const toName = normalizeCategory(to);
  if (!fromName || !toName || fromName === toName) return 0;

  const [fromRows] = (await mysqlPool.execute('SELECT id FROM categories WHERE user_id=? AND name=?', [
    userId,
    fromName,
  ])) as any[];
  const fromRow = (fromRows as any[])[0];
  if (!fromRow) return 0;
  const fromId = Number(fromRow.id);

  const [toRows] = (await mysqlPool.execute('SELECT id FROM categories WHERE user_id=? AND name=?', [
    userId,
    toName,
  ])) as any[];
  const toRow = (toRows as any[])[0];
  if (!toRow) {
    const [result] = (await mysqlPool.execute('UPDATE categories SET name=? WHERE id=? AND user_id=?', [
      toName,
      fromId,
      userId,
    ])) as any[];
    return Number(result.affectedRows ?? 0);
  }

  const toId = Number(toRow.id);
  await mysqlPool.execute(
    'INSERT IGNORE INTO doc_categories (doc_id, category_id) SELECT doc_id, ? FROM doc_categories WHERE category_id=?',
    [toId, fromId],
  );
  await mysqlPool.execute('DELETE FROM doc_categories WHERE category_id=?', [fromId]);
  await mysqlPool.execute('DELETE FROM categories WHERE id=? AND user_id=?', [fromId, userId]);
  return 1;
};

const deleteCategoryInDb = async (
  userId: string,
  name: string,
  mode: 'unlink' | 'purge' | 'unlink-delete-orphans',
) => {
  if (!mysqlPool) throw new Error('DB not configured');
  const categoryName = normalizeCategory(name);
  if (!categoryName) return { removedFrom: 0, deletedDocs: 0 };
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

  const [docRows] = (await mysqlPool.execute(
    `SELECT dc.doc_id AS docId
     FROM doc_categories dc
     JOIN categories c ON c.id = dc.category_id
     WHERE c.user_id = ? AND c.name = ?`,
    [userId, categoryName],
  )) as any[];
  const docIds = (docRows as any[]).map((r) => String(r.docId));

  if (docIds.length === 0) {
    await mysqlPool.execute('DELETE FROM categories WHERE user_id=? AND name=?', [userId, categoryName]);
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
    await mysqlPool.execute('DELETE FROM categories WHERE user_id=? AND name=?', [userId, categoryName]);
    return { removedFrom: 0, deletedDocs };
  }

  await mysqlPool.execute('DELETE FROM categories WHERE user_id=? AND name=?', [userId, categoryName]);

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
    return docs.filter((d) => d.embedding.length);
  }
  return db.docs.filter((d) => d.userId === userId && d.embedding.length);
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

const analyzeScreenshot = async (filePath: string, mime: string): Promise<Analysis> => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
  const safeMime = mime?.startsWith('image/') ? mime : 'image/png';
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
            categories: { type: 'array', items: { type: 'string' } },
            text: { type: 'array', items: { type: 'string' } },
          },
          required: ['caption', 'categories', 'text'],
          additionalProperties: false,
        },
        strict: true,
      },
    },
    messages: [
      {
        role: 'system',
        content:
          'You summarize and categorize screenshots. Extract on-screen text accurately and return concise categories (3-5).',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Return JSON with caption, categories, text array. Keep categories short, lowercase, and thematic.',
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

const embedText = async (text: string) => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const result = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return result.data?.[0]?.embedding ?? [];
};

const buildRetrievalContext = async (query: string, topK: number, userId: string) => {
  const searchable = await listSearchableDocs(userId);
  if (!searchable.length) {
    return { context: '', ranked: [] as { doc: ScreenshotDoc; score: number }[] };
  }
  const queryEmbedding = await embedText(query);
  const ranked = searchable
    .map((doc) => ({
      doc,
      score: cosine(queryEmbedding, doc.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const context = ranked
    .map(
      ({ doc, score }) =>
        `score:${score.toFixed(3)} | caption:${doc.caption} | categories:${doc.categories.join(
          ', ',
        )} | text:${doc.text}`,
    )
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
        const key = c.trim().toLowerCase();
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
  let name = raw.trim().toLowerCase();
  try {
    name = decodeURIComponent(raw).trim().toLowerCase();
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
    const has = before.some((c) => c.trim().toLowerCase() === name);
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

    const nextCategories = before.filter((c) => c.trim().toLowerCase() !== name);
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

    keep.push({ ...doc, categories: nextCategories });
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
  let fromName = raw.trim().toLowerCase();
  try {
    fromName = decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    // ignore malformed encoding; use raw param
  }

  const toRaw = String((req.body as any)?.to ?? '').trim();
  const toName = toRaw.trim().toLowerCase();

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
    const has = before.some((c) => c.trim().toLowerCase() === fromName);
    if (!has) return doc;

    const renamed = before.map((c) => (c.trim().toLowerCase() === fromName ? toName : c));
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const c of renamed) {
      const key = c.trim().toLowerCase();
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
  const fileMime = req.file.mimetype || 'application/octet-stream';
  const isImage = fileMime.startsWith('image/');
  const isVideo = fileMime.startsWith('video/');

  try {
    let doc: ScreenshotDoc;

    if (isImage) {
      const { filePath: usablePath, converted } = await convertImageToPng(req.file.path, fileMime);
      const analysis = await analyzeScreenshot(usablePath, converted ? 'image/png' : fileMime);
      const combinedText = [analysis.caption, ...(analysis.text ?? [])].join('\n');
      const embedding = await embedText(combinedText);
      const id = randomId();

      doc = {
        id,
        userId,
        filePath: usablePath,
        originalName: converted
          ? req.file.originalname.replace(/\.[^.]+$/i, '.png')
          : req.file.originalname,
        fileMime: converted ? 'image/png' : fileMime,
        mediaType: 'image',
        caption: analysis.caption || 'Screenshot',
        categories: analysis.categories?.slice(0, 5) ?? [],
        text: (analysis.text ?? []).join(' '),
        embedding,
        createdAt,
      };
    } else if (isVideo) {
      // Store video without analysis; categorize as "video" to keep it visible in folders.
      const id = randomId();
      doc = {
        id,
        userId,
        filePath: req.file.path,
        originalName: req.file.originalname,
        fileMime,
        mediaType: 'video',
        caption: req.file.originalname,
        categories: ['video'],
        text: '',
        embedding: [],
        createdAt,
      };
    } else {
      const id = randomId();
      doc = {
        id,
        userId,
        filePath: req.file.path,
        originalName: req.file.originalname,
        fileMime,
        mediaType: 'other',
        caption: req.file.originalname,
        categories: ['other'],
        text: '',
        embedding: [],
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
    res.json({ doc: await toPublicDoc(doc) });
  } catch (err: any) {
    console.error('Upload failed', err);
    res.status(500).json({ error: err?.message ?? 'Upload failed' });
  }
});

app.post('/api/search', async (req, res) => {
  const { query, topK = 5 } = req.body as { query?: string; topK?: number };
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
    const { context, ranked } = await buildRetrievalContext(query, topK, userId);
    if (!ranked.length) return res.json({ answer: 'No documents indexed yet.', matches: [] });
    const openaiClient = requireOpenAI();

    const response = await openaiClient.chat.completions.create({
      model: VISION_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a retrieval assistant. Use the provided screenshot context to answer briefly. If unsure, say so.',
        },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
      ],
    });

    const answer =
      response.choices?.[0]?.message?.content ??
      'No response returned. Try again.';
    const matches = await Promise.all(
      ranked.map(async ({ doc, score }) => ({
        ...(await toPublicDoc(doc)),
        score,
      })),
    );
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
  const { query, topK = 5 } = req.body as { query?: string; topK?: number };
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
    const { context, ranked } = await buildRetrievalContext(query, topK, userId);
    if (!ranked.length) {
      writeSse(res, { type: 'info', message: 'No documents indexed yet.' });
      writeSse(res, { type: 'done' });
      res.end();
      return;
    }

    // Send matches upfront
    const matches = await Promise.all(
      ranked.map(async ({ doc, score }) => ({
        ...(await toPublicDoc(doc)),
        score,
      })),
    );
    writeSse(res, { type: 'matches', matches });

    const openaiClient = requireOpenAI();
    const stream = await openaiClient.chat.completions.create(
      {
        model: VISION_MODEL,
        stream: true,
        messages: [
          {
            role: 'system',
            content:
              'You are a retrieval assistant. Use the provided screenshot context to answer briefly. If unsure, say so.',
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
    const userIdRaw = typeof message?.userId === 'string' ? message.userId.trim() : '';
    const userId = userIdRaw && /^[a-zA-Z0-9_-]{3,128}$/.test(userIdRaw) ? userIdRaw : 'public';
    if (!query) {
      wsSend(ws, { type: 'error', message: 'query is required' });
      return;
    }

    abortActive();
    activeController = new AbortController();

    try {
      const { context, ranked } = await buildRetrievalContext(query, topK, userId);
      if (!ranked.length) {
        wsSend(ws, { type: 'info', message: 'No documents indexed yet.' });
        wsSend(ws, { type: 'done' });
        return;
      }

      const matches = await Promise.all(
        ranked.map(async ({ doc, score }) => ({
          ...(await toPublicDoc(doc)),
          score,
        })),
      );
      wsSend(ws, { type: 'matches', matches });

      const openaiClient = requireOpenAI();
      const stream = await openaiClient.chat.completions.create(
        {
          model: VISION_MODEL,
          stream: true,
          messages: [
            {
              role: 'system',
              content:
                'You are a retrieval assistant. Use the provided screenshot context to answer briefly. If unsure, say so.',
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
  if (mysqlPool && DB_AUTO_MIGRATE) {
    try {
      await ensureMysqlSchema();
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
