/**
 * myreminder — Cloudflare Worker API
 * 单用户口令鉴权（ACCESS_CODE 机密）+ D1 持久化（银行卡 / 网站会员）
 */

const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 天
const encoder = new TextEncoder();

/* ---------------------------------- 工具 ---------------------------------- */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

const fail = (status, message) => json({ error: message }, status);

function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(text) {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function safeEqual(a, b) {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/* --------------------------------- 鉴权 ---------------------------------- */

async function verifyCode(env, code) {
  if (!env.ACCESS_CODE) return false;
  const [provided, expected] = await Promise.all([sha256Base64Url(String(code ?? '')), sha256Base64Url(env.ACCESS_CODE)]);
  return safeEqual(provided, expected);
}

async function issueToken(env) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const signature = await hmac(env.ACCESS_CODE, `myreminder.v1.${expiresAt}`);
  return { token: `v1.${expiresAt}.${signature}`, expiresAt };
}

async function verifyToken(env, token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return safeEqual(parts[2], await hmac(env.ACCESS_CODE, `myreminder.v1.${expiresAt}`));
}

// 登录失败限流（按 isolate 内存计数）
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const ATTEMPT_LOCK_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const attempts = new Map();

function takeAttempt(ip) {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now - record.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now, lockedUntil: 0 });
    return { allowed: true };
  }
  if (record.lockedUntil && now < record.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  record.count += 1;
  if (record.count > MAX_ATTEMPTS) {
    record.lockedUntil = now + ATTEMPT_LOCK_MS;
    return { allowed: false, retryAfter: Math.ceil(ATTEMPT_LOCK_MS / 1000) };
  }
  return { allowed: true };
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

async function requireAuth(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail(401, '未登录');
  if (!(await verifyToken(env, token))) return fail(401, '登录已失效，请重新输入口令');
  return null;
}

/* -------------------------------- 字段清洗 -------------------------------- */

const str = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const keyOrOther = (value, max = 64) => {
  const text = str(value, max);
  return text ? text : 'other';
};
const nullableNum = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const dayInMonth = (value) => {
  const parsed = nullableNum(value);
  if (parsed === null) return null;
  const rounded = Math.round(parsed);
  return rounded >= 1 && rounded <= 28 ? rounded : null;
};
const hexColor = (value, fallback = '#3b6bfa') => (/^#[0-9a-fA-F]{6}$/.test(String(value ?? '')) ? String(value).toLowerCase() : fallback);
const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : '');
const expiryMonth = (value) => {
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  return /^(0[1-9]|1[0-2])\/\d{2}$/.test(text) ? text : '';
};
const digits = (value) => String(value ?? '').replace(/[^\d]/g, '').slice(0, 24);

function readCard(body) {
  const cardType = body?.card_type === 'credit' ? 'credit' : 'debit';
  const isCredit = cardType === 'credit';
  return {
    card_type: cardType,
    bank_key: keyOrOther(body?.bank_key),
    bank_name: str(body?.bank_name, 60),
    color: hexColor(body?.color),
    card_number: digits(body?.card_number),
    card_kind: isCredit ? str(body?.card_kind, 40) : '',
    card_network: isCredit ? str(body?.card_network, 40) : '',
    expiry_date: isCredit ? expiryMonth(body?.expiry_date) : '',
    credit_limit: isCredit ? nullableNum(body?.credit_limit) : null,
    billing_day: isCredit ? dayInMonth(body?.billing_day) : null,
    repayment_day: isCredit ? dayInMonth(body?.repayment_day) : null,
    benefits: isCredit ? str(body?.benefits, 2000) : '',
    annual_fee: isCredit ? str(body?.annual_fee, 200) : '',
  };
}

function readMembership(body) {
  return {
    site_key: keyOrOther(body?.site_key),
    site_name: str(body?.site_name, 60),
    color: hexColor(body?.color),
    expiry_date: isoDate(body?.expiry_date),
  };
}

/* ------------------------------- 行 -> 前端 ------------------------------- */

const CARD_SELECT = `id, card_type, bank_key, bank_name, color, card_number, card_kind, card_network,
  expiry_date, credit_limit, billing_day, repayment_day, benefits, annual_fee, sort_order, updated_at`;

const toCard = (row) => ({
  id: row.id,
  type: row.card_type,
  bankKey: row.bank_key,
  bankName: row.bank_name,
  color: row.color,
  number: row.card_number,
  kind: row.card_kind,
  network: row.card_network,
  expiry: row.expiry_date,
  limit: row.credit_limit,
  billingDay: row.billing_day,
  repaymentDay: row.repayment_day,
  benefits: row.benefits,
  annualFee: row.annual_fee,
  sortOrder: row.sort_order,
  updatedAt: row.updated_at,
});

const toMembership = (row) => ({
  id: row.id,
  siteKey: row.site_key,
  siteName: row.site_name,
  color: row.color,
  expiry: row.expiry_date,
  updatedAt: row.updated_at,
});

/* --------------------------------- 路由 ---------------------------------- */

async function listCards(env) {
  const { results } = await env.DB.prepare(`SELECT ${CARD_SELECT} FROM bank_cards ORDER BY sort_order ASC, id ASC`).all();
  return json({ items: results.map(toCard) });
}

async function createCard(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, '请求体格式错误');
  const data = readCard(body);
  if (!data.bank_name) return fail(400, '请填写银行名称');
  if (!data.card_number) return fail(400, '请填写卡号');

  const next = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM bank_cards').first();
  const sortOrder = Number(next?.next ?? 0);

  const { meta } = await env.DB.prepare(
    `INSERT INTO bank_cards
      (card_type, bank_key, bank_name, color, card_number, card_kind, card_network, expiry_date,
       credit_limit, billing_day, repayment_day, benefits, annual_fee, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      data.card_type, data.bank_key, data.bank_name, data.color, data.card_number, data.card_kind,
      data.card_network, data.expiry_date, data.credit_limit, data.billing_day, data.repayment_day,
      data.benefits, data.annual_fee, sortOrder,
    )
    .run();

  const row = await env.DB.prepare(`SELECT ${CARD_SELECT} FROM bank_cards WHERE id = ?`).bind(meta.last_row_id).first();
  return json({ item: toCard(row) }, 201);
}

async function updateCard(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, '请求体格式错误');
  const data = readCard(body);
  if (!data.bank_name) return fail(400, '请填写银行名称');
  if (!data.card_number) return fail(400, '请填写卡号');

  const { meta } = await env.DB.prepare(
    `UPDATE bank_cards SET
       card_type = ?, bank_key = ?, bank_name = ?, color = ?, card_number = ?, card_kind = ?,
       card_network = ?, expiry_date = ?, credit_limit = ?, billing_day = ?, repayment_day = ?,
       benefits = ?, annual_fee = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      data.card_type, data.bank_key, data.bank_name, data.color, data.card_number, data.card_kind,
      data.card_network, data.expiry_date, data.credit_limit, data.billing_day, data.repayment_day,
      data.benefits, data.annual_fee, id,
    )
    .run();

  if (!meta.changes) return fail(404, '记录不存在');
  const row = await env.DB.prepare(`SELECT ${CARD_SELECT} FROM bank_cards WHERE id = ?`).bind(id).first();
  return json({ item: toCard(row) });
}

async function deleteCard(env, id) {
  const { meta } = await env.DB.prepare('DELETE FROM bank_cards WHERE id = ?').bind(id).run();
  if (!meta.changes) return fail(404, '记录不存在');
  return json({ ok: true });
}

async function reorderCards(request, env) {
  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return fail(400, 'ids 不能为空');

  const existing = await env.DB.prepare('SELECT id FROM bank_cards').all();
  const owned = new Set(existing.results.map((row) => Number(row.id)));
  if (ids.some((id) => !owned.has(id)) || new Set(ids).size !== ids.length) return fail(400, '排序数据不完整');

  await env.DB.batch(
    ids.map((id, index) =>
      env.DB.prepare("UPDATE bank_cards SET sort_order = ?, updated_at = datetime('now') WHERE id = ?").bind(index, id),
    ),
  );
  return json({ ok: true, count: ids.length });
}

async function listMemberships(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, site_key, site_name, color, expiry_date, updated_at FROM memberships
     ORDER BY (expiry_date < date('now')) DESC, expiry_date ASC, id ASC`,
  ).all();
  return json({ items: results.map(toMembership) });
}

async function saveMembership(request, env, id = null) {
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, '请求体格式错误');
  const data = readMembership(body);
  if (!data.site_name) return fail(400, '请填写网站名称');
  if (!data.expiry_date) return fail(400, '请填写到期日');

  if (id === null) {
    const { meta } = await env.DB.prepare(
      'INSERT INTO memberships (site_key, site_name, color, expiry_date) VALUES (?, ?, ?, ?)',
    )
      .bind(data.site_key, data.site_name, data.color, data.expiry_date)
      .run();
    const row = await env.DB.prepare('SELECT id, site_key, site_name, color, expiry_date, updated_at FROM memberships WHERE id = ?').bind(meta.last_row_id).first();
    return json({ item: toMembership(row) }, 201);
  }

  const { meta } = await env.DB.prepare(
    "UPDATE memberships SET site_key = ?, site_name = ?, color = ?, expiry_date = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(data.site_key, data.site_name, data.color, data.expiry_date, id)
    .run();
  if (!meta.changes) return fail(404, '记录不存在');
  const row = await env.DB.prepare('SELECT id, site_key, site_name, color, expiry_date, updated_at FROM memberships WHERE id = ?').bind(id).first();
  return json({ item: toMembership(row) });
}

async function deleteMembership(env, id) {
  const { meta } = await env.DB.prepare('DELETE FROM memberships WHERE id = ?').bind(id).run();
  if (!meta.changes) return fail(404, '记录不存在');
  return json({ ok: true });
}

async function handleLogin(request, env) {
  if (!env.ACCESS_CODE) return fail(503, '服务端未配置 ACCESS_CODE，请先设置口令');
  const gate = takeAttempt(clientIp(request));
  if (!gate.allowed) {
    return json({ error: `尝试次数过多，请 ${gate.retryAfter} 秒后重试` }, 429);
  }

  const body = await request.json().catch(() => null);
  if (!body || !(await verifyCode(env, body?.code))) return fail(401, '口令不正确');

  attempts.delete(clientIp(request));
  return json(await issueToken(env));
}

async function routeApi(request, env, pathname) {
  if (pathname === '/api/health') {
    return json({ ok: true, configured: Boolean(env.ACCESS_CODE) });
  }
  if (pathname === '/api/session' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;

  const cardMatch = pathname.match(/^\/api\/cards\/(\d+)$/);
  const memberMatch = pathname.match(/^\/api\/memberships\/(\d+)$/);

  if (pathname === '/api/cards' && request.method === 'GET') return listCards(env);
  if (pathname === '/api/cards' && request.method === 'POST') return createCard(request, env);
  if (pathname === '/api/cards/reorder' && request.method === 'POST') return reorderCards(request, env);
  if (cardMatch && request.method === 'PUT') return updateCard(request, env, Number(cardMatch[1]));
  if (cardMatch && request.method === 'DELETE') return deleteCard(env, Number(cardMatch[1]));

  if (pathname === '/api/memberships' && request.method === 'GET') return listMemberships(env);
  if (pathname === '/api/memberships' && request.method === 'POST') return saveMembership(request, env);
  if (memberMatch && request.method === 'PUT') return saveMembership(request, env, Number(memberMatch[1]));
  if (memberMatch && request.method === 'DELETE') return deleteMembership(env, Number(memberMatch[1]));

  return fail(404, '接口不存在');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await routeApi(request, env, url.pathname);
      } catch (error) {
        console.error('api error', error);
        return fail(500, `服务端错误：${error?.message ?? 'unknown'}`);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fail(404, 'Not Found');
  },
};
