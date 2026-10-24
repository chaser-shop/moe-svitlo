require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const { BOT_TOKEN, MONGO_URI, ADMIN_PASSWORD, ADMIN_CHAT_ID, WEBAPP_URL, SUPPORT_USERNAME = '', PORT = 3000 } = process.env;
if (!BOT_TOKEN || !MONGO_URI || !ADMIN_PASSWORD) {
  console.error('Заповніть BOT_TOKEN, MONGO_URI та ADMIN_PASSWORD у файлі .env');
  process.exit(1);
}

/* ---------- Моделі ---------- */
const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  price: { type: Number, required: true, min: 0 },
  category: { type: String, default: 'lamps' },
  inStock: { type: Boolean, default: true },
  hasImage: { type: Boolean, default: false },
  imageMime: String,
  imageData: { type: Buffer, select: false }, // фото зберігається в MongoDB
}, { timestamps: true });
const Product = mongoose.model('Product', productSchema);

const Order = mongoose.model('Order', new mongoose.Schema({
  tgId: Number, tgName: String,
  name: String, phone: String, address: String, comment: String,
  items: [{ productId: mongoose.Schema.Types.ObjectId, name: String, price: Number, qty: Number }],
  total: Number,
  status: { type: String, default: 'new', enum: ['new', 'processing', 'shipped', 'done', 'cancelled'] },
}, { timestamps: true }));

const CATEGORIES = [
  { id: 'lamps', name: 'Лампи', icon: '💡' },
  { id: 'powerbanks', name: 'Павербанки', icon: '🔋' },
  { id: 'ups', name: 'Безперебійники', icon: '🔌' },
  { id: 'other', name: 'Інше', icon: '🔦' },
];

/* ---------- Допоміжне ---------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const adminOnly = (req, res, next) =>
  crypto.timingSafeEqual(sha(req.get('x-admin-password') || ''), sha(ADMIN_PASSWORD)) ? next() : res.status(401).json({ error: 'Невірний пароль' });

function tgUser(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc !== hash) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
const tg = (method, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json()).catch(e => console.error('Telegram:', e.message));

function applyImage(doc, dataUrl) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return;
  doc.imageMime = m[1];
  doc.imageData = Buffer.from(m[2], 'base64');
  doc.hasImage = true;
}
const pick = b => ({
  name: b.name, description: b.description, price: Number(b.price),
  category: b.category, inStock: b.inStock !== false,
});

/* ---------- Додаток ---------- */
const app = express();
app.set('trust proxy', 1);
app.get('/healthz', (_, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

// Публічні
app.get('/api/config', (_, res) => res.json({ categories: CATEGORIES, support: SUPPORT_USERNAME }));

app.get('/api/products', wrap(async (_, res) => {
  res.json(await Product.find({ inStock: true }).sort('-createdAt').lean());
}));

app.get('/api/products/:id/image', wrap(async (req, res) => {
  const p = await Product.findById(req.params.id).select('+imageData imageMime');
  if (!p || !p.imageData) return res.status(404).end();
  res.set('Content-Type', p.imageMime).set('Cache-Control', 'public, max-age=31536000, immutable').send(p.imageData);
}));

// Замовлення (потрібна валідна Telegram-сесія)
app.post('/api/orders', wrap(async (req, res) => {
  const user = tgUser(req.get('x-init-data'));
  if (!user) return res.status(401).json({ error: 'Відкрийте магазин через Telegram' });
  const { items = [], name, phone, address, comment } = req.body;
  if (!name || !phone || !address || !items.length) return res.status(400).json({ error: 'Заповніть імʼя, телефон і адресу' });

  const products = await Product.find({ _id: { $in: items.map(i => i.id) }, inStock: true }).lean();
  const lines = items.map(i => {
    const p = products.find(p => String(p._id) === i.id);
    return p && { productId: p._id, name: p.name, price: p.price, qty: Math.max(1, Math.min(99, parseInt(i.qty) || 1)) };
  }).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Товарів немає в наявності' });

  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const order = await Order.create({
    tgId: user.id, tgName: [user.first_name, user.last_name].filter(Boolean).join(' '),
    name, phone, address, comment, items: lines, total,
  });
  if (ADMIN_CHAT_ID) {
    tg('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text: `🛒 Нове замовлення №${String(order._id).slice(-6)}\n${name}, ${phone}\n${address}\n\n` +
        lines.map(l => `• ${l.name} × ${l.qty} = ${l.price * l.qty} ₴`).join('\n') + `\n\nРазом: ${total} ₴` +
        (comment ? `\nКоментар: ${comment}` : ''),
    });
  }
  res.json({ ok: true, id: order._id, total });
}));

app.get('/api/orders/my', wrap(async (req, res) => {
  const user = tgUser(req.get('x-init-data'));
  if (!user) return res.json([]);
  res.json(await Order.find({ tgId: user.id }).sort('-createdAt').limit(50).lean());
}));

// Адмінка
app.get('/api/admin/products', adminOnly, wrap(async (_, res) => res.json(await Product.find().sort('-createdAt').lean())));
app.post('/api/admin/products', adminOnly, wrap(async (req, res) => {
  const doc = new Product(pick(req.body));
  applyImage(doc, req.body.image);
  await doc.save();
  res.json({ _id: doc._id });
}));
app.put('/api/admin/products/:id', adminOnly, wrap(async (req, res) => {
  const doc = await Product.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Не знайдено' });
  doc.set(pick(req.body));
  applyImage(doc, req.body.image);
  await doc.save();
  res.json({ ok: true });
}));
app.delete('/api/admin/products/:id', adminOnly, wrap(async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));
app.get('/api/admin/orders', adminOnly, wrap(async (_, res) => res.json(await Order.find().sort('-createdAt').limit(200).lean())));
app.patch('/api/admin/orders/:id', adminOnly, wrap(async (req, res) => {
  await Order.findByIdAndUpdate(req.params.id, { status: req.body.status }, { runValidators: true });
  res.json({ ok: true });
}));

/* ---------- Бот (long polling): /start відкриває магазин ---------- */
async function poll(offset = 0) {
  try {
    const r = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const u of r?.result || []) {
      offset = u.update_id + 1;
      if (u.message?.text?.startsWith('/start') && WEBAPP_URL) {
        tg('sendMessage', {
          chat_id: u.message.chat.id,
          text: '☀️ Моє Світло — світло завжди з тобою.\nЛампи, павербанки та безперебійники.',
          reply_markup: { inline_keyboard: [[{ text: 'Відкрити магазин', web_app: { url: WEBAPP_URL } }]] },
        });
      }
    }
  } catch (e) { console.error('poll:', e.message); await new Promise(r => setTimeout(r, 3000)); }
  setImmediate(() => poll(offset));
}

/* ---------- Анти-сон для Render (free): пінг власного публічного URL кожні 10 хв ---------- */
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || WEBAPP_URL; // RENDER_EXTERNAL_URL Render задає сам
  if (!url || /localhost|127\.0\.0\.1/.test(url)) return;
  setInterval(() => {
    fetch(url.replace(/\/$/, '') + '/healthz').then(r => console.log('keep-alive', r.status)).catch(e => console.error('keep-alive:', e.message));
  }, 10 * 60 * 1000);
}

mongoose.connect(MONGO_URI).then(async () => {
  console.log('MongoDB підключено');
  if (!(await Product.countDocuments())) {
    await Product.insertMany([
      { name: 'LED-лампа з акумулятором 12 Вт', price: 249, category: 'lamps', description: 'Світить до 6 годин без струму.' },
      { name: 'Кемпінгова лампа USB, 20 Вт', price: 399, category: 'lamps', description: 'Підвісна, заряджається через USB.' },
      { name: 'Акумулятор 18650, 3000 mAh', price: 149, category: 'powerbanks', description: 'Li-ion, захист від перезаряду.' },
    ]);
  }
  await tg('deleteWebhook', {});
  poll();
  keepAlive();
  app.listen(PORT, () => console.log(`Магазин: http://localhost:${PORT}  |  Адмінка: http://localhost:${PORT}/admin.html`));
}).catch(e => { console.error('MongoDB:', e.message); process.exit(1); });
