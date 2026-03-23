/**
 * NanoClaw HTTP API server (port 3002).
 *
 * Handles two categories of requests:
 *   1. POST /send — Moneypenny send endpoint (requires API key)
 *   2. Everything else — Portal routes (Authelia-protected, no API key)
 */
import http from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { handlePortalRequest } from './portal.js';

const API_PORT = parseInt(process.env.API_PORT || '3002', 10);

export function startApi(
  sendMessage: (jid: string, text: string) => Promise<void>,
  moneypennyUrl?: string,
): void {
  const mpUrl = moneypennyUrl || process.env.MONEYPENNY_URL || 'http://localhost:3010';
  const secrets = readEnvFile(['NANOCLAW_API_KEY']);
  const apiKey = secrets.NANOCLAW_API_KEY;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost`);

      // ── POST /send — existing Moneypenny send (requires API key) ──
      if (req.method === 'POST' && url.pathname === '/send') {
        // Authenticate with API key
        const providedKey = req.headers['x-api-key'] as string | undefined;
        if (apiKey && providedKey !== apiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', async () => {
          try {
            // Accept both { jid, text } (new) and { to, message } (Moneypenny legacy)
            const data = JSON.parse(body) as {
              jid?: string;
              text?: string;
              to?: string;
              message?: string;
            };
            const jid = data.jid || (data.to ? data.to.replace(/^\+/, '') + '@s.whatsapp.net' : undefined);
            const text = data.text || data.message;
            if (!jid || !text) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Need jid+text or to+message' }));
              return;
            }
            await sendMessage(jid, text);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            logger.error({ err }, 'Error handling /send');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: (err as Error).message }),
            );
          }
        });
        return;
      }

      // ── Everything else — Portal routes (no API key required) ──
      const handled = await handlePortalRequest(req, res, mpUrl);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      logger.error({ err }, 'Unhandled API error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  server.listen(API_PORT, '0.0.0.0', () => {
    logger.info({ port: API_PORT }, 'API server started (portal + send)');
  });
}
