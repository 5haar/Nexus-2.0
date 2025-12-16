# Nexus Server

Lightweight Express API to keep the OpenAI key off the client. Handles:

- Uploading screenshots (multipart form)
- Vision captioning/text extraction + category suggestions
- Embedding storage and cosine RAG search

## Setup

```bash
cd server
npm install
echo "OPENAI_API_KEY=sk-..." > .env
npm run dev   # starts on http://localhost:4000
```

## Endpoints
- `GET /api/health` – basic liveness check.
- `POST /api/upload` – multipart form with `file`; optional `createdAt`. Stores file, runs vision + embedding, saves doc.
- `GET /api/docs` – list stored docs (no embeddings).
- `GET /api/categories` – aggregated categories.
- `POST /api/search` – body `{ "query": "..." }`; embeds query, does cosine ranking over stored docs, and asks OpenAI for an answer.

Uploads are written to `server/storage/uploads/` and metadata to `server/storage/data.json`. This folder is gitignored.

## iOS client

Set `EXPO_PUBLIC_API_BASE_URL` in the app (e.g., `http://<your-LAN-ip>:4000`) so the iPhone simulator/device can reach this server. Use HTTPS in production.
