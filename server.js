require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const { BOT_TOKEN, MONGO_URI, ADMIN_PASSWORD, ADMIN_CHAT_ID, WEBAPP_URL, SUPPORT_USERNAME = '', PORT = 3000, NOVA_POSHTA_API_KEY, MONO_TOKEN, PAYMENT_CARD } = process.env;
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || WEBAPP_URL || '').replace(/\/$/, '');
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
  delivery: { city: String, cityRef: String, warehouse: String, warehouseRef: String },
  payment: { type: String, enum: ['cod', 'prepaid'], default: 'cod' },
  paymentStatus: { type: String, enum: ['cod', 'pending', 'paid', 'failed'], default: 'cod' },
  invoiceId: String,
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

// Нова пошта (ключ API лишається на сервері)
const np = (modelName, calledMethod, methodProperties) => {
  if (!NOVA_POSHTA_API_KEY) throw new Error('Нова пошта не налаштована (NOVA_POSHTA_API_KEY)');
  return fetch('https://api.novaposhta.ua/v2.0/json/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: NOVA_POSHTA_API_KEY, modelName, calledMethod, methodProperties }),
  }).then(r => r.json()).then(j => { if (!j.success) throw new Error(j.errors?.[0] || 'Помилка Нової пошти'); return j.data; });
};
app.get('/api/np/cities', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const d = await np('Address', 'searchSettlements', { CityName: q, Limit: '15' });
  res.json((d[0]?.Addresses || []).filter(a => a.Warehouses !== 0).map(a => ({ ref: a.DeliveryCity, name: a.Present })));
}));
app.get('/api/np/warehouses', wrap(async (req, res) => {
  if (!req.query.cityRef) return res.json([]);
  const d = await np('Address', 'getWarehouses', { CityRef: String(req.query.cityRef), FindByString: String(req.query.q || ''), Limit: '60', Page: '1' });
  res.json(d.map(w => ({ ref: w.Ref, name: w.Description })));
}));

// Mono Acquiring (повна оплата карткою)
async function monoInvoice(order) {
  const r = await fetch('https://api.monobank.ua/api/merchant/invoice/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': MONO_TOKEN },
    body: JSON.stringify({
      amount: Math.round(order.total * 100), ccy: 980,
      merchantPaymInfo: { reference: String(order._id), destination: `Замовлення №${String(order._id).slice(-6)} · Моє Світло` },
      redirectUrl: BASE_URL, webHookUrl: `${BASE_URL}/api/pay/mono-webhook`,
    }),
  }).then(r => r.json());
  if (!r.pageUrl) throw new Error(r.errText || 'Не вдалося створити рахунок');
  order.invoiceId = r.invoiceId; await order.save();
  return r.pageUrl;
}
// Вебхук лише «будить» сервер: статус перевіряємо власним запитом із нашим токеном, тож підробити оплату не можна
app.post('/api/pay/mono-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const id = req.body?.invoiceId;
    if (!id || !MONO_TOKEN) return;
    const st = await fetch('https://api.monobank.ua/api/merchant/invoice/status?invoiceId=' + encodeURIComponent(id), { headers: { 'X-Token': MONO_TOKEN } }).then(r => r.json());
    const o = await Order.findOne({ invoiceId: id });
    if (!o) return;
    if (st.status === 'success' && o.paymentStatus !== 'paid') {
      o.paymentStatus = 'paid'; await o.save();
      if (ADMIN_CHAT_ID) tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `✅ Оплачено замовлення №${String(o._id).slice(-6)} — ${o.total} ₴` });
    } else if (['failure', 'expired', 'reversed'].includes(st.status)) { o.paymentStatus = 'failed'; await o.save(); }
  } catch (e) { console.error('mono-webhook:', e.message); }
});

// Замовлення (потрібна валідна Telegram-сесія)
app.post('/api/orders', wrap(async (req, res) => {
  const user = tgUser(req.get('x-init-data'));
  if (!user) return res.status(401).json({ error: 'Відкрийте магазин через Telegram' });
  const { items = [], name, phone, city, cityRef, warehouse, warehouseRef, payment, comment } = req.body;
  const ph = String(phone || '').replace(/[\s()-]/g, '');
  if (!name || !/^\+?380\d{9}$/.test(ph)) return res.status(400).json({ error: 'Вкажіть імʼя та телефон у форматі +380XXXXXXXXX' });
  if (!cityRef || !warehouseRef || !city || !warehouse) return res.status(400).json({ error: 'Оберіть місто та відділення Нової пошти' });
  if (!['cod', 'prepaid'].includes(payment)) return res.status(400).json({ error: 'Оберіть спосіб оплати' });
  if (!items.length) return res.status(400).json({ error: 'Кошик порожній' });

  const products = await Product.find({ _id: { $in: items.map(i => i.id) }, inStock: true }).lean();
  const lines = items.map(i => {
    const p = products.find(p => String(p._id) === i.id);
    return p && { productId: p._id, name: p.name, price: p.price, qty: Math.max(1, Math.min(99, parseInt(i.qty) || 1)) };
  }).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Товарів немає в наявності' });

  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const order = await Order.create({
    tgId: user.id, tgName: [user.first_name, user.last_name].filter(Boolean).join(' '),
    name, phone: ph, comment, items: lines, total, payment,
    paymentStatus: payment === 'cod' ? 'cod' : 'pending',
    delivery: { city, cityRef, warehouse, warehouseRef },
    address: `Нова пошта: ${city}, ${warehouse}`,
  });
  const num = String(order._id).slice(-6);
  const out = { ok: true, id: order._id, num, total };
  if (payment === 'prepaid') {
    if (MONO_TOKEN && BASE_URL) { try { out.payUrl = await monoInvoice(order); } catch (e) { console.error('mono:', e.message); out.payError = true; } }
    else if (PAYMENT_CARD) out.payCard = PAYMENT_CARD;
  }
  if (ADMIN_CHAT_ID) {
    tg('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text: `🛒 Нове замовлення №${num}\n${name}, ${ph}\n📦 ${order.address}\n💳 ${payment === 'cod' ? 'Накладений платіж' : 'Повна оплата (очікує оплату)'}\n\n` +
        lines.map(l => `• ${l.name} × ${l.qty} = ${l.price * l.qty} ₴`).join('\n') + `\n\nРазом: ${total} ₴` +
        (comment ? `\nКоментар: ${comment}` : ''),
    });
  }
  res.json(out);
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
  const upd = {};
  if (req.body.status) upd.status = req.body.status;
  if (req.body.paymentStatus) upd.paymentStatus = req.body.paymentStatus;
  await Order.findByIdAndUpdate(req.params.id, upd, { runValidators: true });
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
