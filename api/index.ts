import type { Request, Response } from 'express';
import { app } from '../apps/api/src/app.js';
import { validateConfig } from '../apps/api/src/security.js';

// A bounded HTTP handler; the PostgreSQL queue is consumed by a separate daemon.
// Validate before every request, without opening a listening port in a Function.
export default function handler(req: Request, res: Response) {
  try { validateConfig(); }
  catch {
    res.status(503).json({ error: 'Konfigurasi deployment belum siap', code: 'CONFIGURATION' });
    return;
  }
  return app(req, res);
}
