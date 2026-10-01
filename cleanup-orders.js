const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/dapur-rasa.sqlite');
const ids = db.prepare('SELECT id FROM orders ORDER BY created_at DESC').all().map(r => r.id);

for (const id of ids) {
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
}

console.log('deleted orders:', ids.length);
console.log('remaining:', db.prepare('SELECT COUNT(*) AS c FROM orders').get().c);
