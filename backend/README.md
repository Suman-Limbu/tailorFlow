# TailorFlow Backend (Phase 1)

This is the backend service for **TailorFlow** (Digital Tailoring Management System).

Phase 1 provides:
- Express + TypeScript foundation.
- PostgreSQL connection pool using native `pg`.
- Health check endpoint (`GET /api/health`).
- Native SQL migration runner with advisory locks and transactional execution (`npm run migrate`).
- Environment variable protection and secret-safe defaults.

---

## 1. Setup Instructions

### Prerequisites
- Node.js (v20+ recommended, v22 active)
- npm (v10+ recommended, v11 active)
- Supabase project credentials

### Installation
From the `backend` directory, install the required dependencies:
```bash
npm install
```

---

## 2. Environment Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in your Supabase connection string:
   ```env
   PORT=5000
   NODE_ENV=development
   DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres
   CORS_ORIGIN=http://localhost:5173
   ```

> **Note on Supabase Connection:**
> - If your network does not route IPv6 reliably, use the Supabase **Session Pooler** connection string (port 5432 or 6543) available in the Supabase Dashboard under `Project Settings -> Database -> Connection string`.
> - Never commit `.env` to Git. Both root and backend `.gitignore` rules prevent `.env` files from being tracked.

---

## 3. Available Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `npm run dev` | Starts server in watch mode using `tsx` |
| `build` | `npm run build` | Compiles TypeScript source to `dist/` |
| `start` | `npm start` | Runs the compiled output in `dist/server.js` |
| `migrate` | `npm run migrate` | Executes pending native `.sql` migrations using advisory locks |

---

## 4. Health Check Endpoint

- **Endpoint**: `GET /api/health`
- **When Database is Connected**:
  - HTTP Status: `200 OK`
  - Body:
    ```json
    {
      "status": "ok",
      "service": "tailorflow-backend",
      "timestamp": "2026-10-17T...",
      "database": {
        "status": "connected",
        "serverTime": "2026-10-17T..."
      }
    }
    ```
- **When Database is Unconfigured or Unreachable**:
  - HTTP Status: `503 Service Unavailable`
  - Body:
    ```json
    {
      "status": "error",
      "service": "tailorflow-backend",
      "timestamp": "2026-10-17T...",
      "database": {
        "status": "unavailable",
        "message": "Database configuration is missing"
      }
    }
    ```
  - *No database credentials, URLs, or internal stack traces are ever exposed.*
