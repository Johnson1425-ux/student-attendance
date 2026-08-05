import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';

import apiRoutes from './routes/index.js';
import iclockRoutes from './routes/iclock.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { logger } from './config/logger.js';
import { corsOrigins, isTest, env } from './config/env.js';
import { pool } from './db/pool.js';

/**
 * Express application factory. Kept separate from the server bootstrap so tests
 * can mount the app without binding a port.
 */
export function createApp() {
  const app = express();

  // Render (and most PaaS front ends) terminate TLS at a proxy, so req.ip and
  // the rate limiter need the forwarded header to be trusted.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON, CSV and PDF only; the dashboard is a separate
      // origin on Vercel, so a strict default CSP is safe here.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers['x-request-id'] ?? randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(compression());

  // ---------------------------------------------------------------------
  // Terminal endpoints are mounted before CORS and JSON parsing: the device
  // is not a browser, sends text bodies, and must not be subject to the
  // dashboard's origin rules.
  // ---------------------------------------------------------------------
  app.use('/iclock', iclockRoutes);

  app.use(
    cors({
      origin: corsOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['Content-Disposition'],
      maxAge: 86_400,
    }),
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // A broad ceiling that stops a runaway client without ever getting in the way
  // of a school's real traffic (a few hundred requests per user per hour).
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: isTest ? 100_000 : 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'too_many_requests', message: 'Too many requests, please slow down.' } },
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'connected', uptime: Math.round(process.uptime()) });
    } catch (err) {
      res.status(503).json({ status: 'degraded', database: 'unavailable', error: err.message });
    }
  });

  app.get('/', (_req, res) => {
    res.json({
      name: 'Student Fingerprint Attendance System API',
      version: '1.0.0',
      environment: env.NODE_ENV,
      endpoints: { api: '/api', health: '/health', devicePush: '/iclock/cdata' },
    });
  });

  app.use('/api', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
