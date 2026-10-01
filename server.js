require('dotenv').config();

const express = require('express');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const multer = require('multer');
const nodemailer = require('nodemailer');
const webpush = require('web-push');

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, 'data');
const runtimeDataDirectory = process.env.VERCEL ? path.join('/tmp', 'ngemilssby-mima') : dataDirectory;
mkdirSync(runtimeDataDirectory, { recursive: true });

const database = new DatabaseSync(path.join(runtimeDataDirectory, 'dapur-rasa.sqlite'));
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    level TEXT NOT NULL,
    duration TEXT NOT NULL,
    rating REAL NOT NULL,
    students INTEGER NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    old_price INTEGER NOT NULL CHECK (old_price >= 0),
    tag TEXT NOT NULL,
    image TEXT NOT NULL,
    description TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
    payment_method TEXT NOT NULL DEFAULT 'qris' CHECK (payment_method = 'qris'),
    status TEXT NOT NULL DEFAULT 'pending_payment',
    created_at TEXT NOT NULL,
    payment_verified_at TEXT,
    delivery_token TEXT
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    course_title TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
  );
`);

const orderColumns = database.prepare('PRAGMA table_info(orders)').all();
if (!orderColumns.some(column => column.name === 'payment_method')) {
  database.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'qris' CHECK (payment_method = 'qris')");
}
if (!orderColumns.some(column => column.name === 'payment_verified_at')) {
  database.exec('ALTER TABLE orders ADD COLUMN payment_verified_at TEXT');
}
if (!orderColumns.some(column => column.name === 'delivery_token')) {
  database.exec('ALTER TABLE orders ADD COLUMN delivery_token TEXT');
}
if (!orderColumns.some(column => column.name === 'customer_country')) {
  database.exec("ALTER TABLE orders ADD COLUMN customer_country TEXT NOT NULL DEFAULT 'ID' CHECK (customer_country IN ('ID', 'MY'))");
}
const missingDeliveryTokens = database.prepare('SELECT id FROM orders WHERE delivery_token IS NULL').all();
const setDeliveryToken = database.prepare('UPDATE orders SET delivery_token = ? WHERE id = ?');
for (const order of missingDeliveryTokens) {
  setDeliveryToken.run(randomBytes(32).toString('base64url'), order.id);
}

const recipeDirectory = path.resolve(__dirname, process.env.RECIPE_FILES_DIR || 'recipes');
const recipeImageDirectory = path.join(recipeDirectory, 'images');
mkdirSync(recipeImageDirectory, { recursive: true });
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const maintenanceMode = /^(1|true|yes)$/i.test(process.env.MAINTENANCE_MODE || '');
const malaysiaPriceMultiplier = Number(process.env.MALAYSIA_PRICE_MULTIPLIER || 1.35);
const malaysiaIdrPerMyr = Number(process.env.MALAYSIA_IDR_PER_MYR || 3500);
const supportedCountries = {
  ID: { name: 'Indonesia', multiplier: 1 },
  MY: { name: 'Malaysia', multiplier: Number.isFinite(malaysiaPriceMultiplier) && malaysiaPriceMultiplier > 1 ? malaysiaPriceMultiplier : 1.35 }
};
const formatMalaysiaPrice = price => Math.round(price / (Number.isFinite(malaysiaIdrPerMyr) && malaysiaIdrPerMyr > 0 ? malaysiaIdrPerMyr : 3500) * 100) / 100;
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';

async function supabaseRequest(resource, options = {}) {
  if (!supabaseUrl || !supabaseServiceKey) throw new Error('Supabase belum dikonfigurasi.');
  const result = await fetch(`${supabaseUrl}/rest/v1/${resource}`, {
    ...options,
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!result.ok) throw new Error(`Supabase request gagal (${result.status}): ${await result.text()}`);
  return result;
}

async function sendAdminPush(notification) {
  if (!supabaseUrl || !supabaseServiceKey || !vapidPublicKey || !vapidPrivateKey) return;
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapidPublicKey, vapidPrivateKey);
    const response = await supabaseRequest('push_subscriptions?select=id,endpoint,p256dh,auth');
    const subscriptions = await response.json();
    await Promise.all(subscriptions.map(async stored => {
      try {
        await webpush.sendNotification({ endpoint: stored.endpoint, keys: { p256dh: stored.p256dh, auth: stored.auth } }, JSON.stringify(notification));
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          const filter = new URLSearchParams({ endpoint: `eq.${stored.endpoint}` });
          await supabaseRequest(`push_subscriptions?${filter}`, { method: 'DELETE' }).catch(() => {});
        } else {
          console.error('Gagal mengirim push notification:', error.message);
        }
      }
    }));
  } catch (error) {
    console.error('Gagal memproses push notification:', error.message);
  }
}
const maintenancePage = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Segera kembali - ngemilssby.mima</title>
  <style>
    :root { color-scheme: light; --ink: #39372f; --muted: #817b70; --paper: #fff8f1; --green: #52755c; --coral: #e77d72; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; color: var(--ink); background: var(--paper); font-family: Georgia, 'Times New Roman', serif; text-align: center; }
    main { width: min(520px, 100%); padding: 42px 28px; border: 1px solid #efe5dc; border-radius: 12px; background: #fffefd; box-shadow: 0 16px 40px rgb(57 55 47 / 9%); }
    img { width: min(150px, 42vw); height: auto; margin-bottom: 22px; }
    p { margin: 10px auto 0; max-width: 370px; color: var(--muted); font: 15px/1.7 Arial, sans-serif; }
    .eyebrow { color: var(--coral); font: 700 11px/1.2 Arial, sans-serif; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 12px 0 0; font-size: clamp(32px, 7vw, 48px); line-height: 1.05; }
  </style>
</head>
<body><main><img src="/brand-logo.png?v=logo-2" alt="Logo Ngemilss by MIMA"><div class="eyebrow">Sebentar ya</div><h1>Kami sedang menyiapkan sesuatu yang lezat.</h1><p>Website sedang dalam maintenance. Silakan kembali beberapa saat lagi.</p></main></body>
</html>`;
const recipeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 2 },
  fileFilter: (_request, file, callback) => {
    const allowed = file.fieldname === 'pdf'
      ? file.mimetype === 'application/pdf'
      : ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    callback(allowed ? null : new Error('Format file tidak didukung.'), allowed);
  }
});

function buildAdminTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendAdminOrderNotification(order) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transport = buildAdminTransport();
    if (!transport) {
      console.warn('SMTP belum dikonfigurasi. Notifikasi email admin dilewati.');
      return false;
    }

    const itemText = order.items.map(item => `- ${item.title} x${item.quantity}`).join('\n');
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: adminEmail,
      subject: `Order baru: ${order.customerName} • ${order.total.toLocaleString('id-ID')}`,
      text: `Ada order baru dari ${order.customerName} (${order.customerEmail || 'tanpa email'}).\n\n` +
        `Order ID: ${order.orderId}\n` +
        `Total: Rp ${order.total.toLocaleString('id-ID')}\n` +
        `Metode: ${order.paymentMethod}\n\n` +
        `Detail item:\n${itemText}\n\n` +
        `Tautan admin: ${order.adminUrl}`
    });

    console.log('Order notification email sent:', info.messageId);
    return true;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.ADMIN_WHATSAPP_NUMBER;
  if (!accountSid || !authToken || !from || !to) {
    console.warn('SMTP dan Twilio belum dikonfigurasi. Notifikasi admin dilewati.');
    return false;
  }

  const itemText = order.items.map(item => `- ${item.title} x${item.quantity}`).join('\n');
  const message = [
    `Ada order baru dari ${order.customerName} (${order.customerEmail || 'tanpa email'}).`,
    ``,
    `Order ID: ${order.orderId}`,
    `Total: Rp ${order.total.toLocaleString('id-ID')}`,
    `Metode: ${order.paymentMethod}`,
    ``,
    `Detail item:`,
    itemText,
    ``,
    `Admin: ${order.adminUrl}`
  ].join('\n');

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: message
    }).toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio WhatsApp gagal: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  console.log('Order notification WhatsApp sent:', data.sid);
  return true;
}

const videoLessons = {
  'ayam-bawang-putih': [
    { id: 'penggorengan-ayam', title: 'Penggorengan ayam', filename: 'VIDEO PENGGORENGAN AYAM.mp4' },
    { id: 'nasi-bejek', title: 'Pembuatan nasi bejek', filename: 'VIDEO PEMBUATAN NASI BEJEK GURIH.mp4' },
    { id: 'nasi-daun-jeruk', title: 'Pembuatan nasi daun jeruk', filename: 'PEMBUATAN NASI DAUN JERUK.mp4' },
    { id: 'sambal-bawang', title: 'Pembuatan sambal bawang', filename: 'VIDEO PEMBUATAN SAMBAL BAWANG BY MIMA.mp4' },
    { id: 'sambal-matah', title: 'Pembuatan sambal matah', filename: 'VIDEO PEMBUATAN SAMBAL MATAH.mp4' }
  ]
};

const legacyRecipeImageAliases = {
  'Dubai Chewy Cookie.jpeg': 'dubai-chewy-cookie.png',
  '2.jpeg': 'es-pisang-hijoo.png',
  'es piasng ijo.jpeg': 'es-pisang-hijoo.png',
  'es pisang ijo.png': 'es-pisang-hijoo.png',
  'Mangga & Ketan Sticky Rice.jpeg': 'mangga-ketan-sticky-rice.png',
  'dubai-chewy-cookie.jpeg': 'dubai-chewy-cookie.png',
  'es-pisang-hijoo.jpeg': 'es-pisang-hijoo.png',
  'mangga-ketan-sticky-rice.jpeg': 'mangga-ketan-sticky-rice.png'
};

const initialCourses = [
  ['dubai-chewy-cookie', 'Dubai Chewy Cookie', 'Kue & Camilan', 'Resep PDF', 'Bahan & langkah', 0, 0, 18000, 24000, 'PDF Resep', 'recipe-images/dubai-chewy-cookie.png', 'File PDF resep Dubai Chewy Cookie.'],
  ['es-pisang-hijoo', 'Es Pisang Hijoo', 'Dessert', 'Resep PDF', 'Bahan & langkah', 0, 0, 12000, 16000, 'PDF Resep', 'recipe-images/es-pisang-hijoo.png', 'File PDF resep Es Pisang Hijoo.'],
  ['mangga-ketan-sticky-rice', 'Mangga & Nangka Sticky rice', 'Dessert', 'Resep PDF', 'Bahan & langkah', 0, 0, 15000, 21000, 'PDF Resep', 'recipe-images/mangga-ketan-sticky-rice.png', 'File PDF resep Mangga & Nangka Sticky rice.'],
  ['ayam-bawang-putih', 'Ayam Bawang Putih', 'Masakan Gurih', 'Resep PDF', 'Bahan & langkah', 0, 0, 20000, 26000, 'PDF Resep', 'recipe-images/ayam-bawang-putih.png', 'File PDF resep Ayam Bawang Putih.']
];

const existingCourseIds = database.prepare('SELECT id FROM courses').all().map(course => course.id);
const legacyCourseIds = ['nasi-uduk', 'croissant', 'salad', 'soto-ayam', 'banana-bread', 'meal-prep'];
const matchesIds = (left, right) => left.length === right.length && [...left].sort().join('|') === [...right].sort().join('|');

if (existingCourseIds.length === 0 || matchesIds(existingCourseIds, legacyCourseIds)) {
  const insertCourse = database.prepare(`
    INSERT INTO courses (id, title, category, level, duration, rating, students, price, old_price, tag, image, description, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.exec('BEGIN IMMEDIATE');
  try {
    if (existingCourseIds.length) database.exec('DELETE FROM courses');
    initialCourses.forEach((course, index) => insertCourse.run(...course, index));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
database.prepare('UPDATE courses SET image = ? WHERE id = ?').run('recipe-images/dubai-chewy-cookie.png', 'dubai-chewy-cookie');
database.prepare('UPDATE courses SET image = ? WHERE id = ?').run('recipe-images/es-pisang-hijoo.png', 'es-pisang-hijoo');
database.prepare('UPDATE courses SET image = ? WHERE id = ?').run('recipe-images/mangga-ketan-sticky-rice.png', 'mangga-ketan-sticky-rice');
database.prepare('UPDATE courses SET title = ?, description = ? WHERE id = ?').run('Mangga & Nangka Sticky rice', 'File PDF resep Mangga & Nangka Sticky rice.', 'mangga-ketan-sticky-rice');
database.prepare('UPDATE courses SET image = ? WHERE id = ?').run('recipe-images/ayam-bawang-putih.png', 'ayam-bawang-putih');

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.use((request, response, next) => {
  const allowedDuringMaintenance = request.path === '/admin'
    || request.path.startsWith('/api/admin')
    || ['/brand-logo.png', '/hero-image.png', '/image.png'].includes(request.path);
  if (!maintenanceMode || allowedDuringMaintenance) return next();
  if (request.path.startsWith('/api/')) {
    return response.status(503).json({ error: 'Website sedang dalam maintenance.' });
  }
  response.status(503).send(maintenancePage);
});

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/push/public-key', (_request, response) => {
  if (!vapidPublicKey) return response.status(503).json({ error: 'Push notification belum dikonfigurasi.' });
  response.set('Cache-Control', 'no-store').json({ publicKey: vapidPublicKey });
});

app.get('/api/courses', (_request, response) => {
  const courses = database.prepare(`
    SELECT id, title, category, level, duration, rating, students, price,
           old_price AS oldPrice, tag, image, description
    FROM courses
    ORDER BY sort_order, title
  `).all();
  response.set('Cache-Control', 'no-store').json(courses.map(course => ({
    ...course,
    malaysiaIdrPerMyr,
    priceMalaysia: Math.ceil(course.price * supportedCountries.MY.multiplier / 1000) * 1000,
    oldPriceMalaysia: Math.ceil(course.oldPrice * supportedCountries.MY.multiplier / 1000) * 1000,
    priceMalaysiaMyr: formatMalaysiaPrice(Math.ceil(course.price * supportedCountries.MY.multiplier / 1000) * 1000),
    oldPriceMalaysiaMyr: formatMalaysiaPrice(Math.ceil(course.oldPrice * supportedCountries.MY.multiplier / 1000) * 1000),
    videoCount: videoLessons[course.id]?.length || 0
  })));
});

function findOrderByAccessToken(orderId, token) {
  if (typeof token !== 'string' || !token) return null;
  const order = database.prepare(`
        SELECT id, delivery_token, status, total_amount AS total, customer_country AS customerCountry,
          payment_verified_at AS paymentVerifiedAt
    FROM orders WHERE id = ?
  `).get(orderId);
  if (!order?.delivery_token) return null;
  const expected = Buffer.from(order.delivery_token);
  const supplied = Buffer.from(token);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  return order;
}

app.get('/watch/:orderId/:videoId', (request, response) => {
  const order = findOrderByAccessToken(request.params.orderId, request.query.token);
  if (!order?.paymentVerifiedAt) {
    return response.status(404).send('Tautan video tidak valid atau pembayaran belum dikonfirmasi.');
  }

  const courseId = Object.keys(videoLessons).find(id => videoLessons[id].some(video => video.id === request.params.videoId));
  const lesson = videoLessons[courseId]?.find(video => video.id === request.params.videoId);
  if (!lesson) return response.status(404).send('Video tidak ditemukan.');
  const belongsToOrder = database.prepare('SELECT 1 FROM order_items WHERE order_id = ? AND course_id = ?')
    .get(request.params.orderId, courseId);
  if (!belongsToOrder) return response.status(404).send('Video tidak termasuk dalam pesanan ini.');

  response.set('Cache-Control', 'private, no-store').set('Referrer-Policy', 'no-referrer');
  response.sendFile(path.join(__dirname, lesson.filename));
});

app.get('/api/orders/:id/access', (request, response) => {
  const order = findOrderByAccessToken(request.params.id, request.query.token);
  if (!order) return response.status(404).json({ error: 'Tautan pesanan tidak valid.' });
  const items = database.prepare(`
    SELECT course_id AS courseId, course_title AS title, quantity
    FROM order_items WHERE order_id = ? ORDER BY id
  `).all(order.id);
  const paid = Boolean(order.paymentVerifiedAt);
  response.set('Cache-Control', 'private, no-store').set('Referrer-Policy', 'no-referrer').json({
    orderId: order.id,
    status: order.status,
    total: order.total,
    customerCountry: order.customerCountry,
    totalMyr: order.customerCountry === 'MY' ? formatMalaysiaPrice(order.total) : null,
    paymentVerified: paid,
    items: items.map(item => ({
      ...item,
      pdfUrl: paid ? `/api/orders/${encodeURIComponent(order.id)}/recipes/${encodeURIComponent(item.courseId)}?token=${encodeURIComponent(request.query.token)}` : null,
      videos: paid ? (videoLessons[item.courseId] || []).map(video => ({
        ...video,
        url: `/watch/${encodeURIComponent(order.id)}/${encodeURIComponent(video.id)}?token=${encodeURIComponent(request.query.token)}`
      })) : []
    }))
  });
});

app.get('/api/orders/:id/recipes/:courseId', (request, response) => {
  const order = findOrderByAccessToken(request.params.id, request.query.token);
  if (!order?.paymentVerifiedAt) return response.status(404).json({ error: 'Resep belum tersedia sebelum pembayaran dikonfirmasi.' });
  const item = database.prepare('SELECT 1 FROM order_items WHERE order_id = ? AND course_id = ?')
    .get(order.id, request.params.courseId);
  if (!item) return response.status(404).json({ error: 'Resep tidak termasuk dalam pesanan ini.' });
  const pdfPath = path.join(recipeDirectory, `${request.params.courseId}.pdf`);
  if (!existsSync(pdfPath)) return response.status(404).json({ error: 'File PDF resep belum tersedia.' });
  response.set('Cache-Control', 'private, no-store').set('Referrer-Policy', 'no-referrer');
  response.download(pdfPath, `${request.params.courseId}.pdf`);
});

function authenticateAdmin(request, response, next) {
  const expectedToken = process.env.ADMIN_TOKEN;
  const expectedPin = process.env.ADMIN_PIN;
  const authorization = request.get('authorization') || '';
  const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const candidatePin = request.get('x-admin-pin') || '';

  if (!expectedToken) {
    return response.status(503).json({ error: 'Token admin belum dikonfigurasi di server.' });
  }
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(candidate);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return response.status(401).json({ error: 'Token admin tidak valid.' });
  }

  if (expectedPin) {
    const pinExpected = Buffer.from(expectedPin);
    const pinSupplied = Buffer.from(candidatePin);
    if (pinExpected.length !== pinSupplied.length || !timingSafeEqual(pinExpected, pinSupplied)) {
      return response.status(401).json({ error: 'PIN admin tidak valid.' });
    }
  }

  next();
}

function courseInput(request) {
  const body = request.body || {};
  const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const price = Number(body.price);
  const oldPrice = Number(body.oldPrice || body.old_price || body.price);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) throw new Error('ID resep hanya boleh berisi huruf kecil, angka, dan tanda hubung.');
  if (title.length < 2 || title.length > 120) throw new Error('Judul resep harus 2 sampai 120 karakter.');
  if (category.length < 2 || category.length > 60) throw new Error('Kategori resep tidak valid.');
  if (!Number.isInteger(price) || price < 0 || price > 100000000) throw new Error('Harga resep tidak valid.');
  if (!Number.isInteger(oldPrice) || oldPrice < price || oldPrice > 100000000) throw new Error('Harga lama resep tidak valid.');
  if (description.length > 500) throw new Error('Deskripsi resep terlalu panjang.');
  return { id, title, category, price, oldPrice, description: description || `File PDF resep ${title}.` };
}

function saveUpload(file, destination) {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, file.buffer);
  renameSync(temporaryPath, destination);
}

function removeIfExists(filePath) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

function recipeImagePath(courseId, extension = 'jpg') {
  return path.join(recipeImageDirectory, `${courseId}.${extension}`);
}

function removeCourseImages(courseId) {
  for (const extension of ['jpg', 'jpeg', 'png', 'webp']) removeIfExists(recipeImagePath(courseId, extension));
}

    app.use('/api/admin', authenticateAdmin);

    app.post('/api/admin/push-subscriptions', async (request, response) => {
      const subscription = request.body?.subscription;
      const endpoint = subscription?.endpoint;
      const keys = subscription?.keys;
      if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')
        || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
        return response.status(400).json({ error: 'Data subscription notifikasi tidak valid.' });
      }
      try {
        await supabaseRequest('push_subscriptions', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth })
        });
        response.status(201).json({ message: 'Perangkat berhasil didaftarkan untuk notifikasi.' });
      } catch (error) {
        console.error('Gagal menyimpan push subscription:', error.message);
        response.status(503).json({ error: 'Penyimpanan notifikasi belum siap. Periksa konfigurasi Supabase.' });
      }
    });

    app.delete('/api/admin/push-subscriptions', async (request, response) => {
      const endpoint = request.body?.endpoint;
      if (typeof endpoint !== 'string') return response.status(400).json({ error: 'Endpoint subscription tidak valid.' });
      const filter = new URLSearchParams({ endpoint: `eq.${endpoint}` });
      try {
        await supabaseRequest(`push_subscriptions?${filter}`, { method: 'DELETE' });
        response.json({ message: 'Subscription perangkat dihapus.' });
      } catch (error) {
        console.error('Gagal menghapus push subscription:', error.message);
        response.status(503).json({ error: 'Subscription tidak dapat dihapus.' });
      }
    });

    app.get('/api/admin/courses', (_request, response) => {
      const courses = database.prepare(`
        SELECT id, title, category, price, old_price AS oldPrice, description, image
        FROM courses ORDER BY sort_order, title
      `).all();
      response.set('Cache-Control', 'no-store').json({ courses: courses.map(course => ({
        ...course,
        pdfExists: existsSync(path.join(recipeDirectory, `${course.id}.pdf`)),
        imageExists: course.image.startsWith('recipe-images/')
          ? existsSync(path.join(recipeImageDirectory, course.image.slice('recipe-images/'.length)))
          : false
      })) });
    });

    app.post('/api/admin/courses', recipeUpload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'image', maxCount: 1 }]), (request, response) => {
      try {
        const course = courseInput(request);
        const files = request.files || {};
        const pdf = files.pdf?.[0];
        const image = files.image?.[0];
        if (!pdf || !image) return response.status(400).json({ error: 'PDF dan foto resep wajib diunggah.' });
        if (database.prepare('SELECT 1 FROM courses WHERE id = ?').get(course.id)) return response.status(409).json({ error: 'ID resep sudah digunakan.' });
        const maxSort = database.prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM courses').get().value;
        const extension = image.mimetype === 'image/png' ? 'png' : image.mimetype === 'image/webp' ? 'webp' : 'jpg';
        saveUpload(pdf, path.join(recipeDirectory, `${course.id}.pdf`));
        saveUpload(image, recipeImagePath(course.id, extension));
        database.prepare(`
          INSERT INTO courses (id, title, category, level, duration, rating, students, price, old_price, tag, image, description, sort_order)
          VALUES (?, ?, ?, 'Resep PDF', 'Bahan & langkah', 0, 0, ?, ?, 'PDF Resep', ?, ?, ?)
        `).run(course.id, course.title, course.category, course.price, course.oldPrice, `recipe-images/${course.id}.${extension}`, course.description, maxSort + 1);
        response.status(201).json({ message: 'Resep berhasil ditambahkan.' });
      } catch (error) {
        response.status(400).json({ error: error.message || 'Resep gagal ditambahkan.' });
      }
    });

    app.put('/api/admin/courses/:id', recipeUpload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'image', maxCount: 1 }]), (request, response) => {
      try {
        const current = database.prepare('SELECT id, image FROM courses WHERE id = ?').get(request.params.id);
        if (!current) return response.status(404).json({ error: 'Resep tidak ditemukan.' });
        const course = courseInput({ body: { ...request.body, id: current.id } });
        const files = request.files || {};
        if (files.pdf?.[0]) saveUpload(files.pdf[0], path.join(recipeDirectory, `${current.id}.pdf`));
        let imagePath = current.image;
        if (files.image?.[0]) {
          removeCourseImages(current.id);
          const image = files.image[0];
          const extension = image.mimetype === 'image/png' ? 'png' : image.mimetype === 'image/webp' ? 'webp' : 'jpg';
          saveUpload(image, recipeImagePath(current.id, extension));
          imagePath = `recipe-images/${current.id}.${extension}`;
        }
        database.prepare('UPDATE courses SET title = ?, category = ?, price = ?, old_price = ?, description = ?, image = ? WHERE id = ?')
          .run(course.title, course.category, course.price, course.oldPrice, course.description, imagePath, current.id);
        response.json({ message: 'Resep berhasil diperbarui.' });
      } catch (error) {
        response.status(400).json({ error: error.message || 'Resep gagal diperbarui.' });
      }
    });

    app.delete('/api/admin/courses/:id', (request, response) => {
      const course = database.prepare('SELECT id FROM courses WHERE id = ?').get(request.params.id);
      if (!course) return response.status(404).json({ error: 'Resep tidak ditemukan.' });
      const used = database.prepare('SELECT 1 FROM order_items WHERE course_id = ? LIMIT 1').get(course.id);
      if (used) return response.status(409).json({ error: 'Resep sudah pernah dipesan dan tidak boleh dihapus.' });
      database.prepare('DELETE FROM courses WHERE id = ?').run(course.id);
      removeIfExists(path.join(recipeDirectory, `${course.id}.pdf`));
      removeCourseImages(course.id);
      response.json({ message: 'Resep berhasil dihapus.' });
    });

    app.get('/api/admin/orders', (_request, response) => {
      const pendingOrders = database.prepare(`
        SELECT id, customer_name AS customerName, customer_email AS customerEmail,
               customer_country AS customerCountry, total_amount AS total,
               payment_method AS paymentMethod, status, created_at AS createdAt
        FROM orders WHERE status = 'pending_payment'
        ORDER BY created_at DESC
      `).all();
      const getItems = database.prepare(`
        SELECT course_id AS courseId, course_title AS title, quantity
        FROM order_items WHERE order_id = ? ORDER BY id
      `);
      response.set('Cache-Control', 'no-store').json({
        orders: pendingOrders.map(order => ({ ...order, items: getItems.all(order.id) }))
      });
    });

    app.post('/api/admin/orders/:id/confirm-payment', async (request, response) => {
      const order = database.prepare('SELECT id, status FROM orders WHERE id = ?').get(request.params.id);
      if (!order) return response.status(404).json({ error: 'Pesanan tidak ditemukan.' });
      if (order.status !== 'pending_payment') {
        return response.status(409).json({ error: 'Pesanan ini bukan lagi menunggu pembayaran.' });
      }
      const verified = database.prepare(`
        UPDATE orders SET status = 'paid', payment_verified_at = ?
        WHERE id = ? AND status = 'pending_payment'
      `).run(new Date().toISOString(), order.id);
      if (verified.changes !== 1) return response.status(409).json({ error: 'Muat ulang daftar pesanan dan coba lagi.' });
      await sendAdminPush({
        title: 'Pembayaran berhasil',
        body: `Pesanan ${order.id} sudah dikonfirmasi lunas.`,
        url: '/admin'
      });
      response.json({ status: 'paid', message: 'Pembayaran dikonfirmasi. Pembeli dapat membuka resep melalui tautan pesanannya.' });
    });

    app.post('/api/orders', async (request, response) => {
      const name = typeof request.body?.customer?.name === 'string' ? request.body.customer.name.trim() : '';
      const email = typeof request.body?.customer?.email === 'string' ? request.body.customer.email.trim() : '';
      const country = request.body?.customer?.country;
      const paymentMethod = request.body?.paymentMethod;
      const items = request.body?.items;

      if (paymentMethod !== 'qris') {
        return response.status(400).json({ error: 'Metode pembayaran yang tersedia hanya QRIS.' });
      }
      if (name.length < 2 || name.length > 100) {
        return response.status(400).json({ error: 'Nama harus terdiri dari 2 sampai 100 karakter.' });
      }
      if (!Object.hasOwn(supportedCountries, country)) {
        return response.status(400).json({ error: 'Pilih domisili Indonesia atau Malaysia.' });
      }
      if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        return response.status(400).json({ error: 'Alamat email tidak valid.' });
      }
      if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
        return response.status(400).json({ error: 'Pesanan harus berisi 1 sampai 20 kelas.' });
      }

      const quantities = new Map();
      for (const item of items) {
        if (typeof item?.courseId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
          return response.status(400).json({ error: 'Data kelas atau jumlah pesanan tidak valid.' });
        }
        const quantity = (quantities.get(item.courseId) || 0) + item.quantity;
        if (quantity > 10) return response.status(400).json({ error: 'Maksimal 10 akses untuk satu kelas.' });
        quantities.set(item.courseId, quantity);
      }

      const findCourse = database.prepare('SELECT id, title, price FROM courses WHERE id = ? AND price > 0');
      const orderItems = [];
      for (const [courseId, quantity] of quantities) {
        const course = findCourse.get(courseId);
        if (!course) return response.status(400).json({ error: 'Resep tidak tersedia untuk dibeli.' });
        const unitPrice = Math.ceil(course.price * supportedCountries[country].multiplier / 1000) * 1000;
        orderItems.push({ ...course, price: unitPrice, quantity });
      }

      const total = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const orderId = randomUUID();
      const deliveryToken = randomBytes(32).toString('base64url');
      const createdAt = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`
          INSERT INTO orders (id, customer_name, customer_email, customer_country, total_amount, payment_method, status, created_at, delivery_token)
          VALUES (?, ?, ?, ?, ?, 'qris', 'pending_payment', ?, ?)
        `).run(orderId, name, email, country, total, createdAt, deliveryToken);
        const insertItem = database.prepare(`
          INSERT INTO order_items (order_id, course_id, course_title, quantity, unit_price)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const item of orderItems) insertItem.run(orderId, item.id, item.title, item.quantity, item.price);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      const adminUrl = `${appUrl}/admin`;
      try {
        await sendAdminOrderNotification({
          orderId,
          customerName: name,
          customerEmail: email,
          total,
          paymentMethod,
          items: orderItems,
          adminUrl
        });
      } catch (error) {
        console.error('Gagal mengirim notifikasi email admin:', error.message);
      }
      await sendAdminPush({
        title: 'Order baru',
        body: `${name} · Rp ${total.toLocaleString('id-ID')}`,
        url: '/admin'
      });

      response.status(201).json({
        orderId,
        total,
        status: 'pending_payment',
        orderUrl: `/pesanan/${encodeURIComponent(orderId)}?token=${encodeURIComponent(deliveryToken)}`
      });
    });

app.get('/image.png', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.sendFile(path.join(__dirname, 'assets', 'brand', 'logo.png'));
});

app.get('/brand-logo.png', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.sendFile(path.join(__dirname, 'assets', 'brand', 'logo.png'));
});

app.get('/hero-image.png', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.sendFile(path.join(__dirname, 'assets', 'brand', 'logo.png'));
});

app.get('/qris.png', (_request, response) => {
  response.sendFile(path.join(__dirname, 'assets', 'payments', 'qris.png'));
});

app.get('/service-worker.js', (_request, response) => {
  response.set('Cache-Control', 'no-cache');
  response.type('application/javascript').sendFile(path.join(__dirname, 'service-worker.js'));
});

app.get('/manifest.webmanifest', (_request, response) => {
  response.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.webmanifest'));
});

app.get('/recipe-images/dubai-chewy-cookie.jpg', (_request, response) => {
  response.sendFile(path.join(recipeDirectory, 'images', 'dubai-chewy-cookie.jpg'));
});

app.get('/recipe-images/es-pisang-hijoo.jpg', (_request, response) => {
  response.sendFile(path.join(recipeDirectory, 'images', 'es-pisang-hijoo.jpg'));
});

app.get('/recipe-images/mangga-ketan-sticky-rice.jpg', (_request, response) => {
  response.sendFile(path.join(recipeDirectory, 'images', 'mangga-ketan-sticky-rice.jpg'));
});

app.get('/recipe-images/ayam-bawang-putih.png', (_request, response) => {
  response.sendFile(path.join(__dirname, 'assets', 'uploads', 'ayam-bawang-putih-kolase.jpg'));
});

app.get('/recipe-images/:filename', (request, response) => {
  const rawFilename = request.params.filename;
  const filename = legacyRecipeImageAliases[rawFilename] || rawFilename;
  if (path.basename(filename) !== filename || !/\.(jpg|jpeg|png|webp)$/i.test(filename)) return response.status(404).end();
  const imagePath = path.join(recipeImageDirectory, filename);
  if (!existsSync(imagePath)) return response.status(404).end();
  response.sendFile(imagePath);
});

app.get('/admin', (_request, response) => {
  response.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/pesanan/:orderId', (_request, response) => {
  response.set('Cache-Control', 'private, no-store').set('Referrer-Policy', 'no-referrer');
  response.sendFile(path.join(__dirname, 'order.html'));
});

app.get('/', (_request, response) => {
  response.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return response.status(400).json({ error: 'Format JSON tidak valid.' });
  }
  console.error(error);
  response.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

let server;
if (require.main === module) {
  server = app.listen(port, () => {
    console.log(`ngemilssby.mima berjalan di http://localhost:${port}`);
  });
}

function shutdown() {
  const closeServer = server ? callback => server.close(callback) : callback => callback();
  closeServer(() => {
    database.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
