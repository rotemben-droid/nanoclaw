import { createServer } from 'http';

import { logger } from './logger.js';

/**
 * Minimal HTTP API for external services (e.g. Moneypenny) to send
 * WhatsApp messages through NanoClaw.
 *
 * POST /send  { "to": "+19256995147", "message": "Hello" }
 * Header: x-api-key: <NANOCLAW_API_KEY>
 */
export function startApi(
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  const apiKey = process.env.NANOCLAW_API_KEY;
  const port = parseInt(process.env.NANOCLAW_API_PORT || '3002', 10);

  if (!apiKey) {
    logger.warn('NANOCLAW_API_KEY not set — HTTP API disabled');
    return;
  }

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/send') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (req.headers['x-api-key'] !== apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const { to, message } = JSON.parse(body);
        if (!to || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'Need "to" (phone number) and "message"' }),
          );
          return;
        }

        // Convert +19256995147 → 19256995147@s.whatsapp.net
        const jid = to.replace(/^\+/, '') + '@s.whatsapp.net';
        await sendMessage(jid, message);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        logger.error({ err }, 'API send error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  server.listen(port, () => {
    logger.info({ port }, 'NanoClaw HTTP API listening');
  });
}
