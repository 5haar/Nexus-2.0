import cors from 'cors';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { OpenAI } from 'openai';
import { WebSocketServer } from 'ws';

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
  filePath: string;
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
    return JSON.parse(raw) as StoredData;
  } catch (err) {
    console.warn('Failed to read db file', err);
    return { docs: [] };
  }
};

const writeDB = (data: StoredData) => {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

let db: StoredData = readDB();

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

const analyzeScreenshot = async (filePath: string): Promise<Analysis> => {
  if (!openai) throw new Error('Missing OPENAI_API_KEY');
  const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
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
              url: `data:image/png;base64,${base64}`,
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

const buildRetrievalContext = async (query: string, topK: number) => {
  const searchable = db.docs.filter((d) => d.embedding.length);
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

const convertImageToPng = async (filePath: string, mime: string) => {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = mime.startsWith('image/');
  if (!isImage) return { filePath, converted: false };
  if (ext === '.png') return { filePath, converted: false };

  // First try sharp (fast path when libvips has HEIC support)
  const pngPath = `${filePath}.png`;
  try {
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
    throw new Error('Image conversion failed. Ensure image format is supported or convert to PNG/JPEG before upload.');
  }
};

const stripEmbedding = (doc: ScreenshotDoc) => {
  const publicUri = `/uploads/${path.basename(doc.filePath)}`;
  const { embedding: _omit, ...rest } = doc;
  return { ...rest, uri: publicUri };
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/docs', (_req, res) => {
  res.json({ docs: db.docs.map(stripEmbedding) });
});

app.get('/api/categories', (_req, res) => {
  const map: Record<string, number> = {};
  db.docs.forEach((doc) => {
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
});

app.delete('/api/docs/:id', (req, res) => {
  const id = req.params.id;
  const idx = db.docs.findIndex((d) => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [doc] = db.docs.splice(idx, 1);
  try {
    if (doc?.filePath && fs.existsSync(doc.filePath)) {
      fs.unlinkSync(doc.filePath);
    }
  } catch (err) {
    console.warn('Failed to delete file', err);
  }
  writeDB(db);
  res.json({ ok: true });
});

app.delete('/api/categories/:name', (req, res) => {
  const raw = req.params.name ?? '';
  let name = raw.trim().toLowerCase();
  try {
    name = decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    // ignore malformed encoding; use raw param
  }
  const mode = String(req.query.mode ?? 'unlink').toLowerCase(); // unlink | purge | unlink-delete-orphans
  if (!name) return res.status(400).json({ error: 'name is required' });

  let removedFrom = 0;
  let deletedDocs = 0;

  const keep: ScreenshotDoc[] = [];
  for (const doc of db.docs) {
    const before = doc.categories ?? [];
    const has = before.some((c) => c.trim().toLowerCase() === name);
    if (!has) {
      keep.push(doc);
      continue;
    }

    if (mode === 'purge') {
      deletedDocs += 1;
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
  res.json({ ok: true, removedFrom, deletedDocs, remaining: db.docs.length });
});

app.patch('/api/categories/:name', (req, res) => {
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

  let changed = 0;
  db.docs = db.docs.map((doc) => {
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
      const analysis = await analyzeScreenshot(usablePath);
      const combinedText = [analysis.caption, ...(analysis.text ?? [])].join('\n');
      const embedding = await embedText(combinedText);

      doc = {
        id: randomId(),
        filePath: usablePath,
        originalName: converted
          ? req.file.originalname.replace(/\.[^.]+$/i, '.png')
          : req.file.originalname,
        fileMime: 'image/png',
        mediaType: 'image',
        caption: analysis.caption || 'Screenshot',
        categories: analysis.categories?.slice(0, 5) ?? [],
        text: (analysis.text ?? []).join(' '),
        embedding,
        createdAt,
      };
    } else if (isVideo) {
      // Store video without analysis; categorize as "video" to keep it visible in folders.
      doc = {
        id: randomId(),
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
      doc = {
        id: randomId(),
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

    db.docs.unshift(doc);
    writeDB(db);

    res.json({ doc: stripEmbedding(doc) });
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
  const searchable = db.docs.filter((d) => d.embedding.length);
  if (!searchable.length) {
    return res.json({ answer: 'No documents indexed yet.', matches: [] });
  }
  try {
    const { context, ranked } = await buildRetrievalContext(query, topK);
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
    res.json({
      answer,
      matches: ranked.map(({ doc, score }) => ({
        ...stripEmbedding(doc),
        score,
      })),
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

  const searchable = db.docs.filter((d) => d.embedding.length);
  if (!searchable.length) {
    writeSse(res, { type: 'info', message: 'No documents indexed yet.' });
    writeSse(res, { type: 'done' });
    res.end();
    return;
  }

  try {
    const { context, ranked } = await buildRetrievalContext(query, topK);

    // Send matches upfront
    writeSse(res, {
      type: 'matches',
      matches: ranked.map(({ doc, score }) => ({ ...stripEmbedding(doc), score })),
    });

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
    if (!query) {
      wsSend(ws, { type: 'error', message: 'query is required' });
      return;
    }

    abortActive();
    activeController = new AbortController();

    const searchable = db.docs.filter((d) => d.embedding.length);
    if (!searchable.length) {
      wsSend(ws, { type: 'info', message: 'No documents indexed yet.' });
      wsSend(ws, { type: 'done' });
      return;
    }

    try {
      const { context, ranked } = await buildRetrievalContext(query, topK);

      wsSend(ws, {
        type: 'matches',
        matches: ranked.map(({ doc, score }) => ({ ...stripEmbedding(doc), score })),
      });

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

server.listen(PORT, () => {
  console.log(`API ready on http://localhost:${PORT}`);
  console.log(`WS ready on ws://localhost:${PORT}/ws`);
});
