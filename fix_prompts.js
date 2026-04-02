const Database = require('better-sqlite3');
const db = new Database('/opt/homelab/nanoclaw/app/store/messages.db');

const all = db.prepare('SELECT id, name, prompt FROM scheduled_tasks').all();
let fixCount = 0;

all.forEach(j => {
  let p = j.prompt || '';
  // Replace non-ASCII chars inside curl -d '...' bodies with ASCII equivalents
  const newP = p.replace(/-d '([^']+)'/g, function(match, body) {
    // Remove/replace non-ASCII chars
    const fixed = body.replace(/[^\x00-\x7F]/g, function(ch) {
      const cp = ch.codePointAt(0);
      if (cp === 0x1F964) return '[shake]';
      if (cp === 0x1F305) return '[morning]';
      if (cp === 0x2600) return '[sun]';
      if (cp === 0x1F319) return '[moon]';
      if (cp === 0x1F4E7) return '[email]';
      if (cp === 0x1F4C5) return '[calendar]';
      if (cp === 0x1F4AA) return '[workout]';
      return '';  // drop others
    });
    if (fixed === body) return match;
    return "-d '" + fixed + "'";
  });
  if (newP !== p) {
    db.prepare('UPDATE scheduled_tasks SET prompt=? WHERE id=?').run(newP, j.id);
    console.log('Fixed:', j.name);
    fixCount++;
  }
});

console.log('Total fixed:', fixCount);
