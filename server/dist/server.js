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
const getUserIdFromHeader = (req) => {
    const raw = String(req.header('x-nexus-user-id') ?? '').trim();
    if (!raw)
        return 'public';
    if (!/^[a-zA-Z0-9_-]{3,128}$/.test(raw))
        throw new Error('Invalid user id');
    return raw;
};
const writeSse = (res, data) => {
    if (res.writableEnded || res.destroyed)
        return;
    const json = JSON.stringify(data);
    for (const line of json.split(/\r?\n/)) {
        res.write(`data: ${line}\n`);
    }
    res.write('\n');
};
const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VISION_MODEL = 'gpt-5.2';
const EMBED_MODEL = 'text-embedding-3-small';
const MAX_CATEGORIES_PER_DOC = Number(process.env.MAX_CATEGORIES_PER_DOC || 1);
const MAX_EXISTING_CATEGORIES_CONTEXT = Number(process.env.MAX_EXISTING_CATEGORIES_CONTEXT || 50);
const RAG_TOPK_MAX = Number(process.env.RAG_TOPK_MAX || 6);
const RAG_MIN_COSINE = Number(process.env.RAG_MIN_COSINE || 0.18);
const RAG_LEXICAL_WEIGHT = Number(process.env.RAG_LEXICAL_WEIGHT || 0.08);
const RAG_MIN_HYBRID_SCORE = Number(process.env.RAG_MIN_HYBRID_SCORE || 0.19);
const RAG_DOC_TEXT_MAX_CHARS = Number(process.env.RAG_DOC_TEXT_MAX_CHARS || 420);
const RAG_DOC_CAPTION_MAX_CHARS = Number(process.env.RAG_DOC_CAPTION_MAX_CHARS || 120);
if (!OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY is not set. Vision and search will fail.');
}
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const requireOpenAI = () => {
    if (!openai)
        throw new Error('Missing OPENAI_API_KEY');
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
const DB_ENSURE_SCHEMA = process.env.DB_ENSURE_SCHEMA !== '0';
const mysqlPool = DB_HOST && DB_USER && DB_NAME
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
const readDB = () => {
    if (!fs.existsSync(dbPath))
        return { docs: [] };
    try {
        const raw = fs.readFileSync(dbPath, 'utf-8');
        const parsed = JSON.parse(raw);
        parsed.docs = (parsed.docs ?? []).map((doc) => ({
            ...doc,
            userId: typeof doc?.userId === 'string' && doc.userId.trim() ? doc.userId.trim() : 'public',
        }));
        return parsed;
    }
    catch (err) {
        console.warn('Failed to read db file', err);
        return { docs: [] };
    }
};
const writeDB = (data) => {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};
let db = readDB();
const ensureMysqlSchema = async () => {
    if (!mysqlPool)
        return;
    await mysqlPool.execute(`CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
    await mysqlPool.execute(`CREATE TABLE IF NOT EXISTS docs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
    await mysqlPool.execute(`CREATE TABLE IF NOT EXISTS categories (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      UNIQUE KEY uniq_user_category (user_id, name),
      INDEX idx_categories_user (user_id),
      CONSTRAINT fk_categories_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
    await mysqlPool.execute(`CREATE TABLE IF NOT EXISTS doc_categories (
      doc_id VARCHAR(64) NOT NULL,
      category_id BIGINT NOT NULL,
      PRIMARY KEY (doc_id, category_id),
      INDEX idx_dc_category (category_id),
      CONSTRAINT fk_dc_doc FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE,
      CONSTRAINT fk_dc_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
};
let schemaEnsured = null;
const ensureSchemaOnce = async () => {
    if (!mysqlPool)
        return;
    if (!DB_ENSURE_SCHEMA)
        return;
    if (!schemaEnsured) {
        schemaEnsured = ensureMysqlSchema().catch((err) => {
            schemaEnsured = null;
            throw err;
        });
    }
    await schemaEnsured;
};
const normalizeCategoryDbKey = (value) => String(value ?? '').trim().toLowerCase();
const canonicalizeCategory = (value) => {
    let text = normalizeCategoryDbKey(value);
    if (!text)
        return '';
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
    if (!text)
        return '';
    if (/^\d+$/.test(text))
        return '';
    if (!/[a-z]/.test(text))
        return '';
    // Keep tags reasonably short.
    if (text.length > 64)
        text = text.slice(0, 64).trim();
    return text;
};
const ensureUserRow = async (userId) => {
    if (!mysqlPool)
        return;
    await ensureSchemaOnce();
    await mysqlPool.execute('INSERT IGNORE INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
};
const upsertCategoryId = async (userId, name) => {
    if (!mysqlPool)
        throw new Error('DB not configured');
    await ensureSchemaOnce();
    const normalized = canonicalizeCategory(name);
    if (!normalized)
        throw new Error('Invalid category');
    const [result] = (await mysqlPool.execute('INSERT INTO categories (user_id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)', [userId, normalized]));
    return Number(result.insertId);
};
const resolveCategoryIdsInDb = async (userId, name) => {
    if (!mysqlPool)
        throw new Error('DB not configured');
    await ensureSchemaOnce();
    const direct = normalizeCategoryDbKey(name);
    const canonical = canonicalizeCategory(name);
    if (!direct && !canonical)
        return [];
    const ids = new Set();
    const candidates = Array.from(new Set([direct, canonical].filter(Boolean)));
    if (candidates.length) {
        const placeholders = candidates.map(() => '?').join(',');
        const [rows] = (await mysqlPool.execute(`SELECT id FROM categories WHERE user_id=? AND name IN (${placeholders})`, [userId, ...candidates]));
        for (const r of rows) {
            const id = Number(r.id);
            if (Number.isFinite(id))
                ids.add(id);
        }
    }
    if (canonical) {
        // Scan user categories and match by canonicalization (covers older noisy names like "0001 reddit").
        const [allRows] = (await mysqlPool.execute('SELECT id, name FROM categories WHERE user_id=?', [userId]));
        for (const r of allRows) {
            if (canonicalizeCategory(String(r.name ?? '')) !== canonical)
                continue;
            const id = Number(r.id);
            if (Number.isFinite(id))
                ids.add(id);
        }
    }
    return Array.from(ids);
};
const listDocsFromDb = async (userId, opts) => {
    if (!mysqlPool)
        throw new Error('DB not configured');
    await ensureSchemaOnce();
    await ensureUserRow(userId);
    const includeEmbedding = !!opts?.includeEmbedding;
    const fields = includeEmbedding
        ? 'd.embedding AS embedding'
        : "CAST('[]' AS CHAR) AS embedding";
    const [rows] = (await mysqlPool.execute(`SELECT
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
    ORDER BY d.created_at DESC`, [userId]));
    return rows.map((row) => {
        const catsRawOriginal = typeof row.categories === 'string' ? row.categories : row.categories == null ? '' : String(row.categories);
        const catsRaw = catsRawOriginal.split('\\u0001').join(String.fromCharCode(1));
        const categories = catsRaw
            ? Array.from(new Set(catsRaw
                .split('\u0001')
                .map((c) => canonicalizeCategory(c))
                .filter(Boolean)))
            : [];
        let embedding = [];
        if (includeEmbedding) {
            try {
                embedding = JSON.parse(String(row.embedding ?? '[]'));
            }
            catch {
                embedding = [];
            }
        }
        return {
            id: String(row.id),
            userId: String(row.userId),
            originalName: String(row.originalName),
            fileMime: String(row.fileMime),
            mediaType: row.mediaType,
            caption: String(row.caption ?? ''),
            categories,
            text: String(row.text ?? ''),
            embedding,
            createdAt: Number(row.createdAt ?? Date.now()),
            storage: String(row.storage ?? 'local') ?? 'local',
            filePath: row.filePath ? String(row.filePath) : undefined,
            s3Key: row.s3Key ? String(row.s3Key) : undefined,
        };
    });
};
const saveDocToDb = async (doc) => {
    if (!mysqlPool)
        throw new Error('DB not configured');
    await ensureSchemaOnce();
    await ensureUserRow(doc.userId);
    await mysqlPool.execute(`INSERT INTO docs
      (id, user_id, original_name, file_mime, media_type, caption, text, embedding, created_at, storage, file_path, s3_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
    ]);
    const categories = Array.from(new Set((doc.categories ?? []).map((c) => canonicalizeCategory(c)).filter(Boolean))).slice(0, Math.max(1, Math.min(10, MAX_CATEGORIES_PER_DOC)));
    for (const name of categories) {
        const categoryId = await upsertCategoryId(doc.userId, name);
        await mysqlPool.execute('INSERT IGNORE INTO doc_categories (doc_id, category_id) VALUES (?, ?)', [doc.id, categoryId]);
    }
};
const deleteDocFromDb = async (userId, docId) => {
    if (!mysqlPool)
        throw new Error('DB not configured');
    await ensureSchemaOnce();
    const [rows] = (await mysqlPool.execute('SELECT storage, file_path AS filePath, s3_key AS s3Key FROM docs WHERE id=? AND user_id=?', [
        docId,
        userId,
    ]));
    const row = rows[0];
    if (!row)
        return null;
    await mysqlPool.execute('DELETE FROM docs WHERE id=? AND user_id=?', [docId, userId]);
    return {
        storage: row.storage ? String(row.storage) : undefined,
        filePath: row.filePath ? String(row.filePath) : undefined,
        s3Key: row.s3Key ? String(row.s3Key) : undefined,
    };
};
const renameCategoryInDb = async (userId, from, to) => {
    if (!mysqlPool)
        throw new Error('DB not configured');
    await ensureSchemaOnce();
    const fromName = canonicalizeCategory(from);
    const toName = canonicalizeCategory(to);
    if (!fromName || !toName || fromName === toName)
        return 0;
    const fromIds = await resolveCategoryIdsInDb(userId, fromName);
    if (!fromIds.length)
        return 0;
    const toId = await upsertCategoryId(userId, toName);
    let changed = 0;
    for (const fromId of fromIds) {
        if (fromId === toId)
            continue;
        await mysqlPool.execute('INSERT IGNORE INTO doc_categories (doc_id, category_id) SELECT doc_id, ? FROM doc_categories WHERE category_id=?', [toId, fromId]);
        await mysqlPool.execute('DELETE FROM doc_categories WHERE category_id=?', [fromId]);
        await mysqlPool.execute('DELETE FROM categories WHERE id=? AND user_id=?', [fromId, userId]);
        changed += 1;
    }
    return changed ? 1 : 0;
};
const deleteCategoryInDb = async (userId, name, mode) => {
    if (!mysqlPool)
        throw new Error('DB not configured');
    await ensureSchemaOnce();
    const categoryName = canonicalizeCategory(name);
    if (!categoryName)
        return { removedFrom: 0, deletedDocs: 0 };
    const categoryIds = await resolveCategoryIdsInDb(userId, categoryName);
    if (!categoryIds.length) {
        await mysqlPool.execute('DELETE FROM categories WHERE user_id=? AND name=?', [userId, categoryName]);
        return { removedFrom: 0, deletedDocs: 0 };
    }
    const cleanupMeta = async (meta) => {
        if (!meta)
            return;
        if (meta.s3Key) {
            try {
                await deleteS3Object(meta.s3Key);
            }
            catch (err) {
                console.warn('Failed to delete S3 object', err);
            }
        }
        if (meta.filePath) {
            try {
                if (fs.existsSync(meta.filePath))
                    fs.unlinkSync(meta.filePath);
            }
            catch (err) {
                console.warn('Failed to delete file', err);
            }
        }
    };
    const placeholders = categoryIds.map(() => '?').join(',');
    const [docRows] = (await mysqlPool.execute(`SELECT DISTINCT dc.doc_id AS docId
     FROM doc_categories dc
     JOIN categories c ON c.id = dc.category_id
     WHERE c.user_id = ? AND c.id IN (${placeholders})`, [userId, ...categoryIds]));
    const docIds = docRows.map((r) => String(r.docId));
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
    const chunks = [];
    for (let i = 0; i < docIds.length; i += 200)
        chunks.push(docIds.slice(i, i + 200));
    let deletedDocs = 0;
    for (const chunk of chunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const [orphanRows] = (await mysqlPool.execute(`SELECT d.id
       FROM docs d
       LEFT JOIN doc_categories dc ON dc.doc_id = d.id
       WHERE d.user_id=? AND d.id IN (${placeholders})
       GROUP BY d.id
       HAVING COUNT(dc.category_id)=0`, [userId, ...chunk]));
        for (const row of orphanRows) {
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
const listDocs = async (userId) => {
    if (mysqlPool)
        return await listDocsFromDb(userId, { includeEmbedding: false });
    return db.docs.filter((d) => d.userId === userId);
};
const listSearchableDocs = async (userId) => {
    if (mysqlPool) {
        const docs = await listDocsFromDb(userId, { includeEmbedding: true });
        return docs.filter((d) => d.embedding.length);
    }
    return db.docs.filter((d) => d.userId === userId && d.embedding.length);
};
const saveDoc = async (doc) => {
    if (mysqlPool)
        return await saveDocToDb(doc);
    db.docs.unshift(doc);
    writeDB(db);
};
const randomId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const cosine = (a, b) => {
    if (!a.length || !b.length || a.length !== b.length)
        return 0;
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
const listUserCategories = async (userId) => {
    const limit = Math.max(0, Math.min(200, MAX_EXISTING_CATEGORIES_CONTEXT));
    if (mysqlPool) {
        await ensureSchemaOnce();
        const [rows] = (await mysqlPool.execute(`SELECT c.name AS name, COUNT(dc.doc_id) AS cnt
       FROM categories c
       LEFT JOIN doc_categories dc ON dc.category_id = c.id
       WHERE c.user_id=?
       GROUP BY c.id
       ORDER BY cnt DESC, c.name ASC
       LIMIT ?`, [userId, limit]));
        return rows.map((r) => canonicalizeCategory(String(r?.name ?? ''))).filter(Boolean);
    }
    const counts = new Map();
    for (const doc of db.docs) {
        if (doc.userId !== userId)
            continue;
        for (const c of doc.categories ?? []) {
            const key = canonicalizeCategory(c);
            if (!key)
                continue;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([name]) => name);
};
const analyzeScreenshot = async (filePath, mime, existingCategories) => {
    if (!openai)
        throw new Error('Missing OPENAI_API_KEY');
    const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
    const safeMime = mime?.startsWith('image/') ? mime : 'image/png';
    const safeExisting = Array.from(new Set(existingCategories.map((c) => canonicalizeCategory(c)).filter(Boolean))).slice(0, Math.max(0, Math.min(200, MAX_EXISTING_CATEGORIES_CONTEXT)));
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
                        existingCategories: { type: 'array', items: { type: 'string' }, maxItems: 1 },
                        newCategories: { type: 'array', items: { type: 'string' }, maxItems: 1 },
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
                content: 'You summarize screenshots and categorize them. Extract on-screen text accurately. Choose exactly 1 category per screenshot, preferring an existing category when it fits.',
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'Return JSON with caption, existingCategories, newCategories, text array.\n' +
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
    if (!content)
        throw new Error('No analysis content returned');
    return JSON.parse(content);
};
const embedText = async (text) => {
    if (!openai)
        throw new Error('Missing OPENAI_API_KEY');
    const result = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: text,
    });
    return result.data?.[0]?.embedding ?? [];
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const clampInt = (n, min, max) => clamp(Number(n || 0) | 0, min, max);
const truncate = (text, maxChars) => {
    const s = String(text ?? '');
    if (s.length <= maxChars)
        return s;
    return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
};
const tokenize = (text) => {
    const tokens = String(text ?? '')
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g);
    return Array.from(new Set(tokens ?? [])).slice(0, 40);
};
const buildRetrievalContext = async (query, topK, userId, category) => {
    const requestedTopK = clampInt(topK, 1, RAG_TOPK_MAX);
    const categoryKey = category ? canonicalizeCategory(category) : '';
    const searchableAll = await listSearchableDocs(userId);
    if (!searchableAll.length) {
        return { context: '', ranked: [], reason: 'No screenshots indexed yet.' };
    }
    const searchable = categoryKey
        ? searchableAll.filter((d) => (d.categories ?? []).some((c) => canonicalizeCategory(c) === categoryKey))
        : searchableAll;
    if (!searchable.length) {
        return {
            context: '',
            ranked: [],
            reason: categoryKey ? `No screenshots found in “${categoryKey}”.` : 'No screenshots indexed yet.',
        };
    }
    const queryEmbedding = await embedText(query);
    const queryTokens = tokenize(query);
    const ranked = searchable
        .map((doc) => {
        const cosineScore = cosine(queryEmbedding, doc.embedding);
        const docBlob = `${doc.caption}\n${(doc.categories ?? []).join(' ')}\n${doc.text}`;
        const docTokens = tokenize(docBlob);
        const overlap = queryTokens.length === 0 ? 0 : queryTokens.filter((t) => docTokens.includes(t)).length / queryTokens.length;
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
            ranked: [],
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
let sharpLoader = null;
const loadSharp = async () => {
    if (sharpLoader)
        return sharpLoader;
    sharpLoader = import('sharp')
        .then((m) => m?.default ?? m)
        .catch(() => null);
    return sharpLoader;
};
const convertImageToPng = async (filePath, mime) => {
    const ext = path.extname(filePath).toLowerCase();
    const isImage = mime.startsWith('image/');
    if (!isImage)
        return { filePath, converted: false };
    if (ext === '.png')
        return { filePath, converted: false };
    // First try sharp (fast path when libvips has HEIC support)
    const pngPath = `${filePath}.png`;
    try {
        const sharp = await loadSharp();
        if (!sharp)
            throw new Error('sharp unavailable');
        await sharp(filePath).png().toFile(pngPath);
        fs.unlinkSync(filePath);
        return { filePath: pngPath, converted: true };
    }
    catch (err) {
        const isHeic = ext === '.heic' || ext === '.heif' || mime.includes('heic') || mime.includes('heif');
        // Fallback: on macOS, use `sips` to convert HEIC->PNG if available
        if (isHeic && process.platform === 'darwin') {
            try {
                execFileSync('sips', ['-s', 'format', 'png', filePath, '--out', pngPath], { stdio: 'ignore' });
                fs.unlinkSync(filePath);
                return { filePath: pngPath, converted: true };
            }
            catch (sipsErr) {
                throw new Error('HEIC conversion failed. Install libvips with HEIC support or ensure `sips` is available on macOS.');
            }
        }
        return { filePath, converted: false };
    }
};
const signGetUrl = async (key) => {
    if (!s3 || !S3_BUCKET)
        return null;
    try {
        return await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), {
            expiresIn: S3_URL_EXPIRES_SECONDS,
        });
    }
    catch (err) {
        console.warn('Failed to presign S3 URL', err);
        return null;
    }
};
const resolveDocUri = async (doc) => {
    if (doc.storage === 's3' && doc.s3Key) {
        const signed = await signGetUrl(doc.s3Key);
        if (signed)
            return signed;
    }
    if (doc.filePath)
        return `/uploads/${path.basename(doc.filePath)}`;
    return null;
};
const toPublicDoc = async (doc) => {
    const uri = await resolveDocUri(doc);
    const { embedding: _omit, ...rest } = doc;
    return { ...rest, uri };
};
const deleteS3Object = async (key) => {
    if (!s3 || !S3_BUCKET)
        return;
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
};
const uploadToS3 = async (userId, docId, filePath, contentType) => {
    if (!s3 || !S3_BUCKET)
        return null;
    const ext = path.extname(filePath) || (contentType.startsWith('image/') ? '.png' : '');
    const safeExt = ext && ext.length <= 8 ? ext : '';
    const key = `users/${userId}/uploads/${docId}${safeExt}`;
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: contentType,
    }));
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
        }
        catch {
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
    }
    catch (err) {
        res.status(400).json({ error: err?.message ?? 'Invalid request' });
    }
});
app.get('/api/categories', async (req, res) => {
    try {
        const userId = getUserIdFromHeader(req);
        const map = {};
        const docs = await listDocs(userId);
        docs.forEach((doc) => {
            doc.categories.forEach((c) => {
                const key = canonicalizeCategory(c);
                if (!key)
                    return;
                map[key] = (map[key] ?? 0) + 1;
            });
        });
        const categories = Object.entries(map)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name, count }));
        res.json({ categories });
    }
    catch (err) {
        res.status(400).json({ error: err?.message ?? 'Invalid request' });
    }
});
app.delete('/api/docs/:id', (req, res) => {
    let userId = 'public';
    try {
        userId = getUserIdFromHeader(req);
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? 'Invalid request' });
    }
    const id = req.params.id;
    const deleteLocal = (filePath) => {
        if (!filePath)
            return;
        try {
            if (fs.existsSync(filePath))
                fs.unlinkSync(filePath);
        }
        catch (err) {
            console.warn('Failed to delete file', err);
        }
    };
    (async () => {
        try {
            if (mysqlPool) {
                const meta = await deleteDocFromDb(userId, id);
                if (!meta)
                    return res.status(404).json({ error: 'not found' });
                if (meta.s3Key) {
                    try {
                        await deleteS3Object(meta.s3Key);
                    }
                    catch (err) {
                        console.warn('Failed to delete S3 object', err);
                    }
                }
                deleteLocal(meta.filePath);
                return res.json({ ok: true });
            }
            const idx = db.docs.findIndex((d) => d.id === id && d.userId === userId);
            if (idx === -1)
                return res.status(404).json({ error: 'not found' });
            const [doc] = db.docs.splice(idx, 1);
            if (doc?.s3Key) {
                try {
                    await deleteS3Object(doc.s3Key);
                }
                catch (err) {
                    console.warn('Failed to delete S3 object', err);
                }
            }
            deleteLocal(doc?.filePath);
            writeDB(db);
            return res.json({ ok: true });
        }
        catch (err) {
            console.error('Delete failed', err);
            return res.status(500).json({ error: err?.message ?? 'Delete failed' });
        }
    })();
});
app.delete('/api/categories/:name', async (req, res) => {
    let userId = 'public';
    try {
        userId = getUserIdFromHeader(req);
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? 'Invalid request' });
    }
    const raw = req.params.name ?? '';
    let name = canonicalizeCategory(raw);
    try {
        name = canonicalizeCategory(decodeURIComponent(raw));
    }
    catch {
        // ignore malformed encoding; use raw param
    }
    const mode = String(req.query.mode ?? 'unlink').toLowerCase(); // unlink | purge | unlink-delete-orphans
    if (!name)
        return res.status(400).json({ error: 'name is required' });
    if (!['unlink', 'purge', 'unlink-delete-orphans'].includes(mode)) {
        return res.status(400).json({ error: 'invalid mode' });
    }
    if (mysqlPool) {
        try {
            const result = await deleteCategoryInDb(userId, name, mode);
            return res.json({ ok: true, ...result });
        }
        catch (err) {
            console.error('Delete category failed', err);
            return res.status(500).json({ error: err?.message ?? 'Delete category failed' });
        }
    }
    let removedFrom = 0;
    let deletedDocs = 0;
    const keep = [];
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
                }
                catch (err) {
                    console.warn('Failed to delete S3 object', err);
                }
            }
            try {
                if (doc?.filePath && fs.existsSync(doc.filePath)) {
                    fs.unlinkSync(doc.filePath);
                }
            }
            catch (err) {
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
                }
                catch (err) {
                    console.warn('Failed to delete S3 object', err);
                }
            }
            try {
                if (doc?.filePath && fs.existsSync(doc.filePath)) {
                    fs.unlinkSync(doc.filePath);
                }
            }
            catch (err) {
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
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? 'Invalid request' });
    }
    const raw = req.params.name ?? '';
    let fromName = canonicalizeCategory(raw);
    try {
        fromName = canonicalizeCategory(decodeURIComponent(raw));
    }
    catch {
        // ignore malformed encoding; use raw param
    }
    const toRaw = String(req.body?.to ?? '').trim();
    const toName = canonicalizeCategory(toRaw);
    if (!fromName)
        return res.status(400).json({ error: 'name is required' });
    if (!toName)
        return res.status(400).json({ error: 'to is required' });
    if (toName === fromName)
        return res.json({ ok: true, changed: 0 });
    if (mysqlPool) {
        try {
            const changed = await renameCategoryInDb(userId, fromName, toName);
            return res.json({ ok: true, changed });
        }
        catch (err) {
            console.error('Rename failed', err);
            return res.status(500).json({ error: err?.message ?? 'Rename failed' });
        }
    }
    let changed = 0;
    db.docs = db.docs.map((doc) => {
        if (doc.userId !== userId)
            return doc;
        const before = doc.categories ?? [];
        const has = before.some((c) => canonicalizeCategory(c) === fromName);
        if (!has)
            return doc;
        const renamed = before.map((c) => (canonicalizeCategory(c) === fromName ? toName : c));
        const deduped = [];
        const seen = new Set();
        for (const c of renamed) {
            const key = canonicalizeCategory(c);
            if (!key)
                continue;
            if (seen.has(key))
                continue;
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
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? 'Invalid request' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'file is required' });
    }
    const createdAt = Number(req.body.createdAt) || Date.now();
    const fileMime = req.file.mimetype || 'application/octet-stream';
    const isImage = fileMime.startsWith('image/');
    const isVideo = fileMime.startsWith('video/');
    if (isVideo) {
        try {
            if (fs.existsSync(req.file.path))
                fs.unlinkSync(req.file.path);
        }
        catch {
            // ignore
        }
        return res.status(400).json({ error: 'Videos are not supported. Please upload screenshots (photos) only.' });
    }
    try {
        let doc;
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
                    ? req.file.originalname.replace(/\.[^.]+$/i, '.png')
                    : req.file.originalname,
                fileMime: converted ? 'image/png' : fileMime,
                mediaType: 'image',
                caption: analysis.caption || 'Screenshot',
                categories,
                text: (analysis.text ?? []).join(' '),
                embedding,
                createdAt,
            };
        }
        else {
            try {
                if (fs.existsSync(req.file.path))
                    fs.unlinkSync(req.file.path);
            }
            catch {
                // ignore
            }
            return res.status(400).json({ error: 'Only photos are supported. Please upload screenshots.' });
        }
        doc.storage = 'local';
        if (s3 && S3_BUCKET && doc.filePath) {
            try {
                const key = await uploadToS3(userId, doc.id, doc.filePath, doc.fileMime);
                if (key) {
                    doc.storage = 's3';
                    doc.s3Key = key;
                    try {
                        if (fs.existsSync(doc.filePath))
                            fs.unlinkSync(doc.filePath);
                    }
                    catch (err) {
                        console.warn('Failed to delete local upload after S3 put', err);
                    }
                    doc.filePath = undefined;
                }
            }
            catch (err) {
                console.warn('S3 upload failed (falling back to local storage)', err);
                doc.storage = 'local';
            }
        }
        await saveDoc(doc);
        res.json({ doc: await toPublicDoc(doc) });
    }
    catch (err) {
        console.error('Upload failed', err);
        res.status(500).json({ error: err?.message ?? 'Upload failed' });
    }
});
app.post('/api/search', async (req, res) => {
    const { query, topK = 5, category } = req.body;
    if (!query || !query.trim()) {
        return res.status(400).json({ error: 'query is required' });
    }
    let userId = 'public';
    try {
        userId = getUserIdFromHeader(req);
    }
    catch (err) {
        return res.status(400).json({ error: err?.message ?? 'Invalid request' });
    }
    try {
        const { context, ranked, reason } = await buildRetrievalContext(query, topK, userId, category);
        if (!ranked.length)
            return res.json({ answer: reason || 'No screenshots indexed yet.', matches: [] });
        const openaiClient = requireOpenAI();
        const response = await openaiClient.chat.completions.create({
            model: VISION_MODEL,
            messages: [
                {
                    role: 'system',
                    content: 'You are a retrieval assistant. Use only the provided screenshot context to answer briefly. If context is irrelevant or insufficient, say so.',
                },
                { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
            ],
        });
        const answer = response.choices?.[0]?.message?.content ??
            'No response returned. Try again.';
        const matchesRaw = await Promise.all(ranked.map(async ({ doc, score }) => ({
            ...(await toPublicDoc(doc)),
            score,
        })));
        const matches = dedupeMatches(matchesRaw);
        res.json({
            answer,
            matches,
        });
    }
    catch (err) {
        console.error('Search failed', err);
        res.status(500).json({ error: err?.message ?? 'Search failed' });
    }
});
app.post('/api/search-stream', async (req, res) => {
    const { query, topK = 5, category } = req.body;
    if (!query || !query.trim()) {
        res.status(400).json({ error: 'query is required' });
        return;
    }
    let userId = 'public';
    try {
        userId = getUserIdFromHeader(req);
    }
    catch (err) {
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
        if (res.writableEnded || res.destroyed)
            return;
        res.write(': ping\n\n');
    }, 15000);
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted)
            controller.abort();
    };
    req.on('aborted', abort);
    res.on('close', () => {
        if (!res.writableEnded)
            abort();
    });
    res.on('close', () => clearInterval(heartbeat));
    res.on('finish', () => clearInterval(heartbeat));
    try {
        const { context, ranked, reason } = await buildRetrievalContext(query, topK, userId, category);
        if (!ranked.length) {
            writeSse(res, { type: 'info', message: reason || 'No screenshots indexed yet.' });
            writeSse(res, { type: 'done' });
            res.end();
            return;
        }
        // Send matches upfront
        const matchesRaw = await Promise.all(ranked.map(async ({ doc, score }) => ({
            ...(await toPublicDoc(doc)),
            score,
        })));
        const matches = dedupeMatches(matchesRaw);
        writeSse(res, { type: 'matches', matches });
        const openaiClient = requireOpenAI();
        const stream = await openaiClient.chat.completions.create({
            model: VISION_MODEL,
            stream: true,
            messages: [
                {
                    role: 'system',
                    content: 'You are a retrieval assistant. Use only the provided screenshot context to answer briefly. If context is irrelevant or insufficient, say so.',
                },
                { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
            ],
        }, { signal: controller.signal });
        for await (const part of stream) {
            const deltaContent = part.choices?.[0]?.delta?.content;
            if (typeof deltaContent !== 'string' || !deltaContent)
                continue;
            writeSse(res, { type: 'chunk', text: deltaContent });
        }
        writeSse(res, { type: 'done' });
        res.end();
    }
    catch (err) {
        console.error('Search stream failed', err);
        const message = err?.message ?? 'Search failed';
        const isAbort = controller.signal.aborted ||
            err?.name === 'AbortError' ||
            (typeof message === 'string' && /aborted|abort/i.test(message));
        if (!isAbort) {
            writeSse(res, { type: 'error', message });
        }
        res.end();
    }
});
const server = createServer(app);
const wsSend = (ws, data) => {
    if (ws.readyState !== ws.OPEN)
        return;
    ws.send(JSON.stringify(data));
};
const dedupeMatches = (items) => {
    const bestByKey = new Map();
    for (const item of items) {
        const idKey = String(item?.id ?? '').trim();
        const uriKey = String(item?.uri ?? '').trim();
        const key = idKey || uriKey;
        if (!key)
            continue;
        const prev = bestByKey.get(key);
        if (!prev) {
            bestByKey.set(key, item);
            continue;
        }
        const prevScore = Number(prev.score ?? 0);
        const nextScore = Number(item.score ?? 0);
        if (nextScore > prevScore)
            bestByKey.set(key, item);
    }
    const out = Array.from(bestByKey.values());
    out.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    return out;
};
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
    let activeController = null;
    const abortActive = () => {
        if (activeController && !activeController.signal.aborted)
            activeController.abort();
        activeController = null;
    };
    ws.on('close', abortActive);
    ws.on('error', abortActive);
    ws.on('message', async (raw) => {
        let message;
        try {
            const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
            message = JSON.parse(text);
        }
        catch {
            wsSend(ws, { type: 'error', message: 'Invalid JSON message' });
            return;
        }
        if (message?.type !== 'search') {
            wsSend(ws, { type: 'error', message: 'Unknown message type' });
            return;
        }
        const query = typeof message?.query === 'string' ? message.query.trim() : '';
        const topK = typeof message?.topK === 'number' ? message.topK : 5;
        const category = typeof message?.category === 'string' && message.category.trim().length <= 80 ? message.category.trim() : '';
        const userIdRaw = typeof message?.userId === 'string' ? message.userId.trim() : '';
        const userId = userIdRaw && /^[a-zA-Z0-9_-]{3,128}$/.test(userIdRaw) ? userIdRaw : 'public';
        if (!query) {
            wsSend(ws, { type: 'error', message: 'query is required' });
            return;
        }
        abortActive();
        activeController = new AbortController();
        try {
            const { context, ranked, reason } = await buildRetrievalContext(query, topK, userId, category);
            if (!ranked.length) {
                wsSend(ws, { type: 'info', message: reason || 'No screenshots indexed yet.' });
                wsSend(ws, { type: 'done' });
                return;
            }
            const matches = await Promise.all(ranked.map(async ({ doc, score }) => ({
                ...(await toPublicDoc(doc)),
                score,
            })));
            wsSend(ws, { type: 'matches', matches: dedupeMatches(matches) });
            const openaiClient = requireOpenAI();
            const stream = await openaiClient.chat.completions.create({
                model: VISION_MODEL,
                stream: true,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a retrieval assistant. Use only the provided screenshot context to answer briefly. If context is irrelevant or insufficient, say so.',
                    },
                    { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
                ],
            }, { signal: activeController.signal });
            for await (const part of stream) {
                const deltaContent = part.choices?.[0]?.delta?.content;
                if (typeof deltaContent !== 'string' || !deltaContent)
                    continue;
                wsSend(ws, { type: 'chunk', text: deltaContent });
            }
            wsSend(ws, { type: 'done' });
        }
        catch (err) {
            const messageText = err?.message ?? 'Search failed';
            const isAbort = activeController?.signal.aborted ||
                err?.name === 'AbortError' ||
                (typeof messageText === 'string' && /aborted|abort/i.test(messageText));
            if (!isAbort) {
                wsSend(ws, { type: 'error', message: messageText });
            }
        }
        finally {
            activeController = null;
        }
    });
    // Keep-alive for some proxies
    const pingInterval = setInterval(() => {
        if (ws.readyState !== ws.OPEN)
            return;
        ws.ping();
    }, 30000);
    ws.on('close', () => clearInterval(pingInterval));
});
const start = async () => {
    if (mysqlPool && (DB_AUTO_MIGRATE || DB_ENSURE_SCHEMA)) {
        try {
            await ensureSchemaOnce();
            console.log('DB schema ensured.');
        }
        catch (err) {
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
