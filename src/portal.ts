/**
 * Portal business logic — merged from job-manager-server.mjs.
 * All routes, personality injection, family CRUD, tenant CRUD, job CRUD,
 * and WhatsApp group auto-registration for new family members.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import {
  createPerson,
  deleteSession,
  deleteTask as dbDeleteTask,
  getAllPeople,
  getDb,
  getPersonById,
  getPersonByName,
  getTenant,
  updatePerson,
  updateTenant,
  setRegisteredGroup,
} from './db.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { Person, PersonApi } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IPC_DIR = path.join(DATA_DIR, 'ipc');

/** Map person id/name → whatsapp group folder. Dynamically extended at runtime. */
const NAME_TO_GROUP: Record<string, string> = {
  rotem: 'whatsapp_main',
  miko: 'whatsapp_miko',
  itay: 'whatsapp_itay',
  danielle: 'whatsapp_danielle',
  noya: 'whatsapp_noya',
};

// ---------------------------------------------------------------------------
// Personality presets
// ---------------------------------------------------------------------------

export const PERSONALITY_PRESETS: Record<string, string> = {
  classic_butler:
    'You are in *British Butler* mode. Impeccably formal, measured, and dignified \u2014 think Jeeves from P.G. Wodehouse. Use complete sentences and precise vocabulary. Phrases like "Indeed", "As you wish", "I have taken the liberty of", and "Quite so" are natural. Never use contractions in formal statements. Dry, perfectly restrained wit is permitted \u2014 but never slapstick. If the person makes a mistake, acknowledge it with supreme tact.',

  snarky_ai:
    'You are in *Head Chef* mode. Direct, passionate, and results-obsessed \u2014 Gordon Ramsay\'s drive channeled entirely into helpfulness. Lead with the answer, no preamble. Short punchy sentences. "Right, here\'s exactly what we\'re doing." "No excuses \u2014 execute." Cut fluff ruthlessly. Occasional kitchen metaphors are fine ("Let\'s prep this properly", "This is undercooked, let\'s fix it"). Deeply competent, never cruel.',

  warm_friend:
    'You are in *Warm Friend* mode. Genuinely caring, casual, and encouraging \u2014 like a brilliant best friend who happens to know everything. Use their name naturally in conversation. Light warmth in every message. A touch of humor when appropriate. "Hey! Big day today \u2014 you\'ve got this." Never clinical, never stiff. Make them feel genuinely seen and supported.',

  coach:
    'You are in *Sabra* mode \u2014 Israeli directness with deep warmth underneath. Get straight to the point. Zero patience for beating around the bush, but genuinely invested in this person. "Yalla, let\'s go." "Here\'s the deal, straight up." Short, honest sentences. A Hebrew word feels natural occasionally (yalla, sababa, b\'seder, nu). Underneath the directness: real care and loyalty.',

  storyteller:
    'You are in *Storyteller* mode \u2014 creative, narrative, and full of wonder. Every task is a small adventure. Every message can be a chapter. Use vivid language, metaphor, and imagination freely. Bedtime messages become mini-stories with characters and stakes. Reminders feel like quests. Celebrate small wins dramatically. Keep the magic alive \u2014 especially for children.',
};

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  he: 'Hebrew',
  both: 'English and Hebrew',
};

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  email: 'Email',
  phone: 'Phone',
  none: 'None',
};

const PRESET_DISPLAY_NAMES: Record<string, string> = {
  classic_butler: 'British Butler \ud83c\udfa9',
  snarky_ai: 'Head Chef \ud83d\udc68\u200d\ud83c\udf73',
  warm_friend: 'Warm Friend \ud83e\udd17',
  coach: 'Sabra \ud83c\uddee\ud83c\uddf1',
  storyteller: 'Storyteller \ud83d\udcd6',
};

// ---------------------------------------------------------------------------
// Prompt injection / personality context
// ---------------------------------------------------------------------------

function buildPromptInjection(row: Person): string {
  const presetText =
    PERSONALITY_PRESETS[row.jarvis_personality] ||
    PERSONALITY_PRESETS.classic_butler;
  const langLabel = LANGUAGE_LABELS[row.language] || row.language || 'English';
  const channelLabel =
    CHANNEL_LABELS[row.preferred_channel] ||
    row.preferred_channel ||
    'WhatsApp';
  const quietStart = row.quiet_hours_start || '22:00';
  const quietEnd = row.quiet_hours_end || '07:00';

  let prompt = `--- PERSONALITY FOR ${row.name.toUpperCase()} ---\n`;
  prompt += presetText + '\n';
  if (row.jarvis_personality_custom && row.jarvis_personality_custom.trim()) {
    prompt += `\nAdditional tone instructions from the owner: ${row.jarvis_personality_custom.trim()}\n`;
  }
  prompt += `\nContext: You are talking to ${row.name} (${row.relation || 'family member'}).`;
  prompt += ` Communicate in ${langLabel}.`;
  prompt += ` Preferred channel: ${channelLabel}.`;
  prompt += ` Do not contact between ${quietStart} and ${quietEnd} local time.`;
  prompt += '\n--- END PERSONALITY ---';
  return prompt;
}

export function writePersonalityContext(row: Person): void {
  const folderKey = row.id || row.name.toLowerCase();
  const folderName = NAME_TO_GROUP[folderKey];
  if (!folderName) return;
  const groupPath = path.join(GROUPS_DIR, folderName);
  if (!fs.existsSync(groupPath)) return;
  const content =
    `<!-- Auto-generated by Jarvis Portal \u2014 do not edit manually -->\n` +
    `<!-- Last updated: ${new Date().toISOString()} -->\n\n` +
    buildPromptInjection(row) +
    '\n';
  try {
    fs.writeFileSync(
      path.join(groupPath, 'personality-context.md'),
      content,
      'utf8',
    );
    logger.info({ person: row.name }, 'Wrote personality-context.md');
  } catch (err) {
    logger.error(
      { person: row.name, err },
      'Failed to write personality-context.md',
    );
  }
}

export function writeAllPersonalityContexts(): void {
  try {
    const people = getAllPeople('benisrael');
    for (const p of people) {
      // Convert API person back to flat row for writePersonalityContext
      const flat: Person = {
        ...p,
        quiet_hours_start: p.quiet_hours.start,
        quiet_hours_end: p.quiet_hours.end,
      };
      writePersonalityContext(flat);
    }
    logger.info(
      { count: people.length },
      'Wrote all personality context files',
    );
  } catch (err) {
    logger.error({ err }, 'writeAllPersonalityContexts failed');
  }
}

// ---------------------------------------------------------------------------
// Phase 2.7 — WhatsApp group auto-registration for new family members
// ---------------------------------------------------------------------------

/**
 * Generate a personalized CLAUDE.md for a new person's WhatsApp group folder.
 * Based on the templates used for miko/itay/danielle.
 */
export function generatePersonCLAUDE(person: Person): string {
  const personalityLabel =
    PRESET_DISPLAY_NAMES[person.jarvis_personality] ||
    person.jarvis_personality ||
    'Warm Friend';
  const langLabel =
    LANGUAGE_LABELS[person.language] || person.language || 'English';
  const relationLower = (person.relation || 'family member').toLowerCase();

  // Build a capabilities section based on contact tier
  let capabilities = `- Answer questions and have conversations
- Read and write files in your workspace (\`/workspace/group/\`)
- Run bash commands in your sandbox
- Send messages back to the chat`;

  if (person.contact_tier >= 3) {
    capabilities += `\n- Make phone calls and send WhatsApp messages via Moneypenny`;
  }
  if (person.contact_tier >= 5) {
    capabilities += `\n- Check Gmail and iCloud calendars via Moneypenny`;
  }
  if (person.contact_tier >= 6) {
    capabilities += `\n- Browse the web with \`agent-browser\``;
  }

  // Determine how the family table should describe this person's relation
  const allPeople = getAllPeople('benisrael');
  const familyTable = allPeople
    .filter((p) => p.id !== 'noya' || person.id === 'noya')
    .map((p) => {
      const isSelf = p.id === person.id;
      const rel = isSelf ? 'self' : p.relation.toLowerCase();
      const notes = p.id === 'noya' ? 'Do NOT contact' : p.notes || '';
      const phone = p.phone || p.whatsapp || '\u2014';
      return `| ${p.name} | ${phone} | ${rel} | ${notes} |`;
    })
    .join('\n');

  // Default fallback preset name for session startup
  const fallbackPreset = PERSONALITY_PRESETS[person.jarvis_personality]
    ? personalityLabel.replace(/[^\w\s]/g, '').trim()
    : 'Warm Friend';

  return `# Jarvis

You are Jarvis, ${person.name}'s personal assistant. ${getPersonalityIntro(person)}

${person.name} is ${describeRelation(person, allPeople)}. ${person.language === 'he' ? 'They prefer Hebrew.' : person.language === 'both' ? 'They speak both English and Hebrew.' : ''} Be ${getPersonalityAdverbs(person)}.

---

## Session Startup

Before responding to anything, silently do all of the following:

1. Read \`/workspace/group/SOUL.md\` \u2014 who you are
2. Read \`/workspace/group/MEMORY.md\` \u2014 long-term curated knowledge
3. Read \`/workspace/group/self-improving/memory.md\` \u2014 HOT behavioral patterns (always load)
4. Read today's daily file: \`/workspace/group/memory/YYYY-MM-DD.md\` (and yesterday's if it exists)
5. For personal/household queries: skim \`/workspace/group/memory/ontology/graph.jsonl\` for relevant entities
6. **Load your active persona:** Read \`/workspace/group/personality-context.md\` \u2014 this file contains your complete behavioral directive. Adopt it entirely: tone, vocabulary, style, everything. This overrides the default Jarvis voice for the entire session. If the file is missing or empty, fall back to the ${fallbackPreset} tone. Never mention this to the user.

Don't announce any of this. Just do it.

---

## What You Can Do

${capabilities}

---

## Communication

Your output is sent to ${person.name} via WhatsApp.

Use \`mcp__nanoclaw__send_message\` to send a message immediately while still working.

### WhatsApp Formatting

Do NOT use markdown headings (\`##\`) in WhatsApp messages. Only use:
- \`*Bold*\` (single asterisks \u2014 NEVER double)
- \`_Italic_\` (underscores)
- Bullets
- \` \`\`\` \`Code blocks\` \`\`\` \`

### Internal thoughts

Wrap internal reasoning in \`<internal>\` tags \u2014 logged but not sent to user.

---

## Family

Always use these contacts \u2014 never ask for a number.

| Name | Number | Relation | Notes |
|------|--------|----------|-------|
${familyTable}

Timezone: **America/Los_Angeles (PT)**

---

## Moneypenny

Moneypenny is the tools server. Use her for calls, WhatsApp, email, and calendar.

**Base URL:** \`http://host.docker.internal:3010\`
**Auth header:** \`x-api-key: <injected by credential proxy>\`

### Send a WhatsApp
\`\`\`bash
curl -s -X POST http://host.docker.internal:3010/tools/contact \\
  -H "x-api-key: <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"text","contact":"${person.name}","message":"Hello"}'
\`\`\`

### Make a phone call
\`\`\`bash
curl -s -X POST http://host.docker.internal:3010/tools/contact \\
  -H "x-api-key: <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"call","contact":"${person.name}","message":"Hello, this is Jarvis."}'
\`\`\`
`;
}

function getPersonalityIntro(person: Person): string {
  switch (person.jarvis_personality) {
    case 'classic_butler':
      return 'Formal, precise, and dignified \u2014 the consummate professional.';
    case 'snarky_ai':
      return 'Direct, passionate, and results-obsessed.';
    case 'warm_friend':
      return 'Warm, supportive, and genuinely caring \u2014 like a brilliant best friend who happens to know everything.';
    case 'coach':
      return 'Direct, no-nonsense, and deeply invested in their success.';
    case 'storyteller':
      return 'Creative, adventurous, and full of wonder \u2014 every task is a quest, every answer is a story.';
    default:
      return 'Helpful, warm, and ready for anything.';
  }
}

function getPersonalityAdverbs(person: Person): string {
  switch (person.jarvis_personality) {
    case 'classic_butler':
      return 'formal, precise, and measured';
    case 'snarky_ai':
      return 'direct, punchy, and efficient';
    case 'warm_friend':
      return 'warm, encouraging, and natural';
    case 'coach':
      return 'direct, honest, and motivating';
    case 'storyteller':
      return 'imaginative, fun, and encouraging';
    default:
      return 'helpful, warm, and attentive';
  }
}

function describeRelation(person: Person, allPeople: PersonApi[]): string {
  const owner = allPeople.find((p) => p.relation === 'Self');
  const ownerName = owner?.name || 'the owner';
  const rel = (person.relation || '').toLowerCase();
  if (rel === 'self') return `${ownerName}`;
  if (rel === 'spouse') return `${ownerName}'s spouse`;
  if (rel === 'son') return `${ownerName}'s son`;
  if (rel === 'daughter') return `${ownerName}'s daughter`;
  if (rel === 'child') return `${ownerName}'s child`;
  return `a ${person.relation || 'family member'}`;
}

/**
 * Phase 2.7: Create group folder, CLAUDE.md, register JID, write personality-context.
 * Called when POST /api/family adds a new person with a phone number.
 */
export function registerNewPersonGroup(person: Person): void {
  const personId =
    person.id || person.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const folderName = `whatsapp_${personId}`;

  // Skip if blocked (tier 0) or no phone number
  if (person.contact_tier === 0) {
    logger.info(
      { person: person.name },
      'Skipping group registration for blocked person',
    );
    return;
  }
  const phone = person.phone || person.whatsapp;
  if (!phone) {
    logger.info(
      { person: person.name },
      'Skipping group registration: no phone number',
    );
    return;
  }

  // Validate folder name
  if (!isValidGroupFolder(folderName)) {
    logger.warn(
      { folderName },
      'Generated folder name is invalid, skipping auto-registration',
    );
    return;
  }

  // 1. Create groups/whatsapp_{id}/ directory
  const groupPath = path.join(GROUPS_DIR, folderName);
  fs.mkdirSync(path.join(groupPath, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(groupPath, 'memory'), { recursive: true });

  // 2. Write personalized CLAUDE.md
  const claudeContent = generatePersonCLAUDE(person);
  fs.writeFileSync(path.join(groupPath, 'CLAUDE.md'), claudeContent, 'utf8');
  logger.info(
    { person: person.name, folder: folderName },
    'Wrote CLAUDE.md for new person',
  );

  // 3. Derive WhatsApp JID from phone number
  const jid = phone.replace(/^\+/, '') + '@s.whatsapp.net';

  // 4. Register in registered_groups table
  try {
    setRegisteredGroup(jid, {
      name: person.name,
      folder: folderName,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    });
    logger.info(
      { person: person.name, jid, folder: folderName },
      'Registered WhatsApp group for new person',
    );
  } catch (err) {
    logger.error({ err, jid, folder: folderName }, 'Failed to register group');
  }

  // 5. Update NAME_TO_GROUP mapping
  NAME_TO_GROUP[personId] = folderName;

  // 6. Write personality-context.md
  writePersonalityContext(person);
}

// ---------------------------------------------------------------------------
// Moneypenny dual-write helpers
// ---------------------------------------------------------------------------

/** Path to Moneypenny family.json — mounted volume from docker-compose. */
function getMpFamilyPath(): string {
  return process.env.MP_FAMILY_PATH || '/opt/homelab/moneypenny/family.json';
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function dualWriteToMoneypenny(person: Person, changedFields: string[]): void {
  const mpPath = getMpFamilyPath();
  const contactChanged = ['phone', 'whatsapp', 'email', 'name'].some((f) =>
    changedFields.includes(f),
  );
  if (!contactChanged) return;

  try {
    const mpRaw = readJson<Record<string, unknown>[]>(mpPath, []);
    const mpArr: Record<string, unknown>[] = Array.isArray(mpRaw)
      ? (mpRaw as Record<string, unknown>[])
      : (mpRaw as unknown as { people?: Record<string, unknown>[] }).people ||
        [];
    const lookupName = (person.name || '').toLowerCase();
    const mpEntry = mpArr.find(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        (m.name as string)?.toLowerCase() === lookupName,
    );

    if (mpEntry) {
      if (
        changedFields.includes('phone') ||
        changedFields.includes('whatsapp')
      ) {
        mpEntry.number =
          person.phone || person.whatsapp || mpEntry.number || '';
      }
      if (changedFields.includes('email')) {
        mpEntry.email = person.email || null;
      }
      if (changedFields.includes('name')) {
        mpEntry.name = person.name;
        mpEntry.aliases = [person.name.toLowerCase()];
      }
      writeJson(mpPath, mpArr);
      logger.info({ person: person.name }, 'Updated Moneypenny contact');
    } else {
      mpArr.push({
        name: person.name,
        number: person.phone || person.whatsapp || '',
        email: person.email || null,
        relation: (person.relation || 'other').toLowerCase(),
        aliases: [person.name.toLowerCase()],
      });
      writeJson(mpPath, mpArr);
      logger.info({ person: person.name }, 'Added to Moneypenny family.json');
    }
  } catch (err) {
    logger.error(
      { err, person: person.name },
      'Moneypenny dual-write failed (non-fatal)',
    );
  }
}

// ---------------------------------------------------------------------------
// Moneypenny proxy helper
// ---------------------------------------------------------------------------

function proxyMoneypenny(
  moneypennyUrl: string,
  tool: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const secrets = readEnvFile(['MONEYPENNY_API_KEY', 'NANOCLAW_API_KEY']);
  const apiKey =
    secrets.MONEYPENNY_API_KEY ||
    '2acc8deb480657669c15f511df33ee13824392e1d6c556ad21e406eddbbb44c9';
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const mpUrl = new URL(moneypennyUrl);
    const req = http.request(
      {
        hostname: mpUrl.hostname,
        port: parseInt(mpUrl.port) || 80,
        path: `/tools/${tool}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': apiKey,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 200, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 200, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function errorResponse(
  res: http.ServerResponse,
  msg: string,
  status = 400,
): void {
  jsonResponse(res, { error: msg }, status);
}

function parseBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function computeNextRun(expr: string): string | null {
  try {
    return CronExpressionParser.parse(expr, { tz: TIMEZONE })
      .next()
      .toISOString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

/**
 * Handle all portal HTTP routes.
 * Returns true if the route was handled, false if not matched.
 */
export async function handlePortalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  moneypennyUrl: string,
): Promise<boolean> {
  const url = new URL(req.url || '/', `http://localhost`);
  const p = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  // ── Logged-in user (Authelia forward-auth headers) ─────────
  if (req.method === 'GET' && p === '/api/me') {
    jsonResponse(res, {
      user: req.headers['remote-user'] || null,
      name: req.headers['remote-name'] || null,
      email: req.headers['remote-email'] || null,
      groups: req.headers['remote-groups'] || null,
    });
    return true;
  }

  // ── Serve HTML UI ──────────────────────────────────────────
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    // Look for job-manager.html in the project root
    const htmlPath = path.join(process.cwd(), 'job-manager.html');
    try {
      res.writeHead(200, { 'Content-Type': 'text/html', ...CORS });
      res.end(fs.readFileSync(htmlPath));
    } catch {
      res.writeHead(404);
      res.end('job-manager.html not found');
    }
    return true;
  }

  // ── GET /api/jobs ──────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/jobs') {
    const db = getDb();
    const jobs = db
      .prepare(
        `SELECT id,
                CASE WHEN status = 'disabled' OR status = 'paused' THEN 0 ELSE 1 END AS enabled,
                CASE WHEN name IS NOT NULL AND name != '' THEN name
                     ELSE SUBSTR(prompt, 1, CASE WHEN INSTR(prompt, CHAR(10)) > 0
                                                 THEN INSTR(prompt, CHAR(10)) - 1
                                                 ELSE MIN(LENGTH(prompt), 80) END)
                END AS name,
                group_folder, chat_jid, prompt, schedule_type, schedule_value,
                context_mode, next_run, status, created_at,
                last_run
         FROM scheduled_tasks ORDER BY next_run ASC`,
      )
      .all();
    jsonResponse(res, jobs);
    return true;
  }

  // ── POST /api/jobs ─────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/jobs') {
    try {
      const body = await parseBody(req);
      const sv =
        (body.schedule_value as string) ||
        (body.cron_expr as string) ||
        (body.schedule as string);
      if (!sv) {
        errorResponse(res, 'schedule_value is required');
        return true;
      }
      const id = randomUUID();
      const nextRun = computeNextRun(sv);
      const db = getDb();
      db.prepare(
        `INSERT INTO scheduled_tasks
           (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
            context_mode, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        id,
        body.group_folder || 'main',
        body.chat_jid || 'tg:1449522448',
        body.prompt || '',
        body.schedule_type || 'cron',
        sv,
        body.context_mode || 'isolated',
        nextRun,
        new Date().toISOString(),
      );
      const created = db
        .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
        .get(id);
      jsonResponse(res, created, 201);
    } catch (e) {
      errorResponse(res, (e as Error).message);
    }
    return true;
  }

  // ── /api/jobs/:id routes ───────────────────────────────────
  const singleMatch = p.match(/^\/api\/jobs\/([^/]+)$/);

  // PATCH /api/jobs/:id
  if ((req.method === 'PATCH' || req.method === 'PUT') && singleMatch) {
    try {
      const id = singleMatch[1];
      const db = getDb();
      const task = db
        .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!task) {
        errorResponse(res, 'Not found', 404);
        return true;
      }
      const body = await parseBody(req);
      const sets: string[] = [];
      const vals: unknown[] = [];

      if (body.name !== undefined) {
        sets.push('id = ?');
        vals.push(body.name);
      }
      if (body.prompt !== undefined) {
        sets.push('prompt = ?');
        vals.push(body.prompt);
      }
      if (body.context_mode !== undefined) {
        sets.push('context_mode = ?');
        vals.push(body.context_mode);
      }
      const sv =
        (body.schedule_value as string) ||
        (body.cron_expr as string) ||
        (body.schedule as string);
      if (sv !== undefined) {
        sets.push('schedule_value = ?');
        vals.push(sv);
        sets.push('next_run = ?');
        vals.push(computeNextRun(sv));
      }
      if (body.enabled !== undefined) {
        const en = body.enabled ? 1 : 0;
        sets.push('status = ?');
        vals.push(en ? 'active' : 'paused');
        if (en) {
          sets.push('next_run = ?');
          vals.push(computeNextRun(task.schedule_value as string));
        }
      }
      if (body.status !== undefined) {
        sets.push('status = ?');
        vals.push(body.status);
      }

      if (sets.length > 0) {
        db.prepare(
          `UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`,
        ).run(...vals, id);
      }
      const updated = db
        .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
        .get(body.name !== undefined ? body.name : id);
      jsonResponse(res, updated);
    } catch (e) {
      errorResponse(res, (e as Error).message);
    }
    return true;
  }

  // DELETE /api/jobs/:id
  if (req.method === 'DELETE' && singleMatch) {
    const id = singleMatch[1];
    dbDeleteTask(id);
    jsonResponse(res, { deleted: true });
    return true;
  }

  // POST /api/jobs/:id/run
  const runMatch = p.match(/^\/api\/jobs\/([^/]+)\/run$/);
  if (req.method === 'POST' && runMatch) {
    const id = runMatch[1];
    const db = getDb();
    if (!db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id)) {
      errorResponse(res, 'Not found', 404);
      return true;
    }
    db.prepare(
      "UPDATE scheduled_tasks SET next_run = ?, status = 'active' WHERE id = ?",
    ).run(new Date(Date.now() - 1000).toISOString(), id);
    jsonResponse(res, { triggered: true, id });
    return true;
  }

  // ── GET /api/family ────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/family') {
    const people = getAllPeople('benisrael');
    jsonResponse(res, { tenant_id: 'benisrael', people });
    return true;
  }

  // ── PUT/PATCH /api/family/:id ──────────────────────────────
  const familyMatch = p.match(/^\/api\/family\/([^/]+)$/);
  if ((req.method === 'PUT' || req.method === 'PATCH') && familyMatch) {
    try {
      const personId = familyMatch[1];
      const existing = getPersonById(personId);
      if (!existing) {
        errorResponse(res, 'Person not found', 404);
        return true;
      }

      const body = await parseBody(req);
      const result = updatePerson(personId, body);
      if (!result) {
        errorResponse(res, 'Update failed', 500);
        return true;
      }

      const updated = getPersonById(personId)!;

      // Personality change detection
      const personalityChanged =
        (body.jarvis_personality !== undefined &&
          body.jarvis_personality !== existing.jarvis_personality) ||
        body.jarvis_personality_custom !== undefined;

      // Always sync personality-context.md
      writePersonalityContext(updated);

      if (personalityChanged) {
        const folderName =
          NAME_TO_GROUP[updated.name.toLowerCase()] ||
          NAME_TO_GROUP[updated.id];
        if (folderName) {
          // Clear session so next message starts fresh
          deleteSession(folderName);
          logger.info(
            { person: updated.name, folder: folderName },
            'Reset session for personality change',
          );

          // IPC notification
          try {
            const db = getDb();
            const reg = db
              .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
              .get(folderName) as { jid: string } | undefined;
            if (reg?.jid) {
              const presetName =
                PRESET_DISPLAY_NAMES[updated.jarvis_personality] ||
                updated.jarvis_personality;
              const ipcDir = path.join(IPC_DIR, folderName, 'messages');
              fs.mkdirSync(ipcDir, { recursive: true });
              fs.writeFileSync(
                path.join(ipcDir, `personality-notify-${Date.now()}.json`),
                JSON.stringify({
                  type: 'message',
                  chatJid: reg.jid,
                  text: `Heads up \u2014 my personality was just updated to *${presetName}* mode. Fresh start from here \ud83d\udc4b`,
                }),
                'utf8',
              );
              logger.info(
                { person: updated.name, jid: reg.jid },
                'IPC personality notify queued',
              );
            }
          } catch (err) {
            logger.error({ err }, 'IPC notify failed');
          }
        }
      }

      // Dual-write to Moneypenny
      dualWriteToMoneypenny(updated, result.changedFields);

      jsonResponse(res, {
        ...result.person,
        session_reset: personalityChanged,
      });
    } catch (e) {
      errorResponse(res, (e as Error).message);
    }
    return true;
  }

  // ── POST /api/family ───────────────────────────────────────
  if (req.method === 'POST' && p === '/api/family') {
    try {
      const body = await parseBody(req);
      if (!body.name) {
        errorResponse(res, 'name is required');
        return true;
      }
      const id =
        (body.id as string) ||
        (body.name as string).toLowerCase().replace(/[^a-z0-9]/g, '_');

      // Check duplicates
      if (getPersonById(id)) {
        errorResponse(res, `Person "${id}" already exists`);
        return true;
      }

      const person = createPerson(body);

      // Dual-write to Moneypenny
      const flat = getPersonById(id)!;
      dualWriteToMoneypenny(flat, ['name', 'phone', 'whatsapp', 'email']);

      // Phase 2.7: auto-register WhatsApp group
      registerNewPersonGroup(flat);

      jsonResponse(res, person, 201);
    } catch (e) {
      errorResponse(res, (e as Error).message);
    }
    return true;
  }

  // ── GET /api/tenant ────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/tenant') {
    const tenant = getTenant('benisrael');
    if (!tenant) {
      errorResponse(res, 'Tenant not found', 404);
    } else {
      jsonResponse(res, tenant);
    }
    return true;
  }

  // ── PATCH /api/tenant ──────────────────────────────────────
  if (req.method === 'PATCH' && p === '/api/tenant') {
    try {
      const body = await parseBody(req);
      const updated = updateTenant('benisrael', body);
      if (!updated) {
        errorResponse(res, 'No valid fields to update', 400);
        return true;
      }
      jsonResponse(res, updated);
    } catch (e) {
      errorResponse(res, (e as Error).message);
    }
    return true;
  }

  // ── GET /api/health/moneypenny ─────────────────────────────
  if (req.method === 'GET' && p === '/api/health/moneypenny') {
    try {
      const mpUrl = new URL(moneypennyUrl);
      const result = await new Promise<{ status: number }>(
        (resolve, reject) => {
          const r = http.request(
            {
              hostname: mpUrl.hostname,
              port: parseInt(mpUrl.port) || 80,
              path: '/health',
              method: 'GET',
            },
            (res2) => {
              resolve({ status: res2.statusCode || 500 });
              res2.resume();
            },
          );
          r.on('error', reject);
          r.setTimeout(3000, () => {
            r.destroy();
            reject(new Error('timeout'));
          });
          r.end();
        },
      );
      jsonResponse(res, { online: result.status < 500, status: result.status });
    } catch {
      jsonResponse(res, { online: false });
    }
    return true;
  }

  // ── GET /api/person-context/:name ──────────────────────────
  const personCtxMatch = p.match(/^\/api\/person-context\/([^/]+)$/);
  if (req.method === 'GET' && personCtxMatch) {
    const nameParam = decodeURIComponent(personCtxMatch[1]);
    const row = getPersonByName(nameParam);
    if (!row) {
      errorResponse(res, `Person "${nameParam}" not found`, 404);
      return true;
    }
    jsonResponse(res, {
      person_id: row.id,
      name: row.name,
      jarvis_personality: row.jarvis_personality || 'classic_butler',
      jarvis_personality_custom: row.jarvis_personality_custom || '',
      contact_tier: row.contact_tier,
      preferred_channel: row.preferred_channel || 'whatsapp',
      language: row.language || 'en',
      prompt_injection: buildPromptInjection(row),
    });
    return true;
  }

  // ── GET /api/moneypenny-family ─────────────────────────────
  if (req.method === 'GET' && p === '/api/moneypenny-family') {
    const mpPath = getMpFamilyPath();
    const data = readJson<unknown>(mpPath, null);
    if (!data) {
      errorResponse(res, 'Moneypenny family.json not found', 404);
      return true;
    }
    jsonResponse(res, data);
    return true;
  }

  // ── POST /api/proxy/:tool ──────────────────────────────────
  const proxyMatch = p.match(/^\/api\/proxy\/([a-z_]+)$/);
  if (req.method === 'POST' && proxyMatch) {
    const tool = proxyMatch[1];
    const allowed = ['contact', 'check_email', 'check_calendar', 'recall'];
    if (!allowed.includes(tool)) {
      errorResponse(res, 'Unknown tool', 400);
      return true;
    }
    try {
      const body = await parseBody(req);
      const result = await proxyMoneypenny(moneypennyUrl, tool, body);
      jsonResponse(res, result.body, result.status);
    } catch (e) {
      errorResponse(res, (e as Error).message, 502);
    }
    return true;
  }

  // ── GET /api/jobs/:id/log — last 10 runs for a job ────────
  const jobLogMatch = p.match(/^\/api\/jobs\/([^/]+)\/log$/);
  if (req.method === 'GET' && jobLogMatch) {
    try {
      const db = getDb();
      const runs = db
        .prepare(
          `
        SELECT id, task_id AS job_id, run_at, status, result AS result_preview, duration_ms
        FROM task_run_logs WHERE task_id = ?
        ORDER BY run_at DESC LIMIT 10
      `,
        )
        .all(jobLogMatch[1]);
      jsonResponse(res, runs);
    } catch (e) {
      jsonResponse(res, { error: String(e) }, 500);
    }
    return true;
  }

  // ── GET /api/jobs/runs — flat recent run log with job names ─
  if (req.method === 'GET' && p === '/api/jobs/runs') {
    try {
      const db = getDb();
      const limit = Math.min(
        parseInt(String(url.searchParams.get('limit') || '50')) || 50,
        200,
      );
      const runs = db
        .prepare(
          `SELECT l.id, l.task_id AS job_id, st.name AS job_name, st.prompt,
                  l.run_at, l.status, l.duration_ms, l.result, l.error
           FROM task_run_logs l
           LEFT JOIN scheduled_tasks st ON st.id = l.task_id
           ORDER BY l.run_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        id: number;
        job_id: string;
        job_name: string | null;
        prompt: string | null;
        run_at: string;
        status: string;
        duration_ms: number;
        result: string | null;
        error: string | null;
      }>;
      // Derive display name from name or first line of prompt
      const enriched = runs.map((r) => ({
        ...r,
        display_name:
          r.job_name ||
          (r.prompt || '').split('\n')[0].substring(0, 80) ||
          r.job_id,
      }));
      jsonResponse(res, enriched);
    } catch (e) {
      jsonResponse(res, { error: String(e) }, 500);
    }
    return true;
  }

  // ── GET /api/jobs/history — 7-day run history for ALL jobs ─
  if (req.method === 'GET' && p === '/api/jobs/history') {
    try {
      const db = getDb();
      const days = parseInt(String(url.searchParams.get('days') || '7')) || 7;
      const since = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000,
      ).toISOString();
      const runs = db
        .prepare(
          `
        SELECT task_id AS job_id, run_at, status
        FROM task_run_logs WHERE run_at > ?
        ORDER BY run_at DESC
      `,
        )
        .all(since);
      // Group by job_id
      const byJob: Record<string, Array<{ date: string; status: string }>> = {};
      (
        runs as Array<{ job_id: string; run_at: string; status: string }>
      ).forEach((r) => {
        if (!byJob[r.job_id]) byJob[r.job_id] = [];
        byJob[r.job_id].push({
          date: r.run_at.substring(0, 10),
          status: r.status,
        });
      });
      jsonResponse(res, byJob);
    } catch (e) {
      jsonResponse(res, { error: String(e) }, 500);
    }
    return true;
  }

  // ── GET /api/status — is Jarvis currently running a job? ──
  if (req.method === 'GET' && p === '/api/status') {
    try {
      const db = getDb();
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const running = db
        .prepare(
          `
        SELECT id, id AS name FROM scheduled_tasks
        WHERE status = 'running' AND created_at > ?
        LIMIT 1
      `,
        )
        .get(cutoff) as { id: string; name: string } | undefined;
      jsonResponse(res, {
        running: !!running,
        current_job: running?.name || null,
      });
    } catch (e) {
      jsonResponse(res, { running: false, current_job: null });
    }
    return true;
  }

  // Route not matched
  return false;
}
