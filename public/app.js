/* ============================================================
 * RabbitReminder PWA 前端
 * 两个 Tab：
 *   1) 银行卡：借记卡(银行/卡号) / 信用卡(+种类/有效期/额度/组织/账单日/还款日/权益/年费)
 *      卡片拖拽排序、点击编辑、品牌色卡面、可调卡面颜色
 *   2) 网站会员：网站名/到期日，按到期远近自动排序（不可手工排序）
 * 数据通过 Cloudflare Worker API 存 D1；本地口令登录。
 * ============================================================ */

(() => {
  'use strict';

  const APP_VERSION = new URL(document.currentScript.src).searchParams.get('v');

  const { banks: BANK_PRESETS, sites: SITE_PRESETS } = window.MYREMINDER_BRANDS;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const firstChar = (name) => {
    const text = String(name || '').trim();
    return text ? [...text][0] : '?';
  };

  const luminance = (hex) => {
    const value = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const textOn = (hex) => (luminance(hex) > 0.62 ? '#1c2333' : '#ffffff');

  const api = async (path, options = {}) => {
    const requestToken = session.token;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      // 旧会话的迟到响应不能把刚建立的新会话退出。
      if (session.token === requestToken) invalidateSession();
      throw new Error(payload.error || '登录已失效');
    }
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload;
  };

  /* ------------------------------ 状态 ------------------------------ */

  const session = { token: localStorage.getItem('mr_token') || '', busy: false, error: '' };
  const state = {
    tab: 'cards', // 'cards' | 'sites'
    cardFilter: null, // null | 'debit' | 'credit'
    cards: [],
    memberships: [],
    reveal: new Set(), // 已展开完整卡号的 card id
    loading: false,
  };

  const BUSINESS_CACHE_DB = 'rabbitreminder-business-v1';
  const BUSINESS_CACHE_STORE = 'snapshots';
  let sessionGeneration = 0;
  let cacheDbPromise = null;
  let cacheWriteQueue = Promise.resolve();
  let cacheResetPromise = Promise.resolve();

  const currentSession = () => ({ token: session.token, generation: sessionGeneration });
  const isCurrentSession = (context) =>
    Boolean(context?.token) && context.token === session.token && context.generation === sessionGeneration;

  function resetBusinessState() {
    state.cards = [];
    state.memberships = [];
    state.reveal.clear();
    state.loading = false;
  }

  function invalidateSession() {
    session.token = '';
    sessionGeneration += 1;
    localStorage.removeItem('mr_token');
    resetBusinessState();
    closeSheet();
    void clearBusinessCache().catch(() => {});
    render();
  }

  function setAuthenticatedToken(token) {
    session.token = token;
    sessionGeneration += 1;
    localStorage.setItem('mr_token', token);
    resetBusinessState();
  }

  function openBusinessCache() {
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (cacheDbPromise) return cacheDbPromise;
    cacheDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(BUSINESS_CACHE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(BUSINESS_CACHE_STORE)) {
          request.result.createObjectStore(BUSINESS_CACHE_STORE, { keyPath: 'scope' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          cacheDbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        cacheDbPromise = null;
        reject(request.error || new Error('无法打开本地缓存'));
      };
    });
    return cacheDbPromise;
  }

  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('本地缓存操作失败'));
  });

  async function sessionScope(token) {
    const bytes = new TextEncoder().encode(token);
    if (window.crypto?.subtle) {
      const digest = await window.crypto.subtle.digest('SHA-256', bytes);
      return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    // 老旧 WebView 的非加密退化方案：仅持久化不可逆的稳定摘要，不保存明文 token。
    let hashA = 0x811c9dc5;
    let hashB = 0x9e3779b9;
    for (const byte of bytes) {
      hashA = Math.imul(hashA ^ byte, 0x01000193) >>> 0;
      hashB = Math.imul(hashB ^ byte, 0x85ebca6b) >>> 0;
    }
    return `fallback:${hashA.toString(16).padStart(8, '0')}${hashB.toString(16).padStart(8, '0')}:${bytes.length}`;
  }

  async function readCachedSnapshot(context) {
    try {
      await cacheResetPromise;
      if (!isCurrentSession(context)) return null;
      const scope = await sessionScope(context.token);
      if (!isCurrentSession(context)) return null;
      const db = await openBusinessCache();
      const snapshot = await requestResult(db.transaction(BUSINESS_CACHE_STORE, 'readonly').objectStore(BUSINESS_CACHE_STORE).get(scope));
      if (!isCurrentSession(context) || !snapshot) return null;
      if (!Array.isArray(snapshot.cards) || !Array.isArray(snapshot.memberships)) return null;
      return { cards: snapshot.cards, memberships: snapshot.memberships };
    } catch (_) {
      return null;
    }
  }

  function queueSnapshotWrite(context) {
    cacheWriteQueue = cacheWriteQueue.catch(() => {}).then(async () => {
      await cacheResetPromise;
      if (!isCurrentSession(context)) return;
      const scope = await sessionScope(context.token);
      if (!isCurrentSession(context)) return;
      const snapshot = {
        scope,
        cards: Array.isArray(state.cards) ? state.cards : [],
        memberships: Array.isArray(state.memberships) ? state.memberships : [],
        updatedAt: Date.now(),
      };
      const db = await openBusinessCache();
      if (!isCurrentSession(context)) return;
      await requestResult(db.transaction(BUSINESS_CACHE_STORE, 'readwrite').objectStore(BUSINESS_CACHE_STORE).put(snapshot));
    });
    // 缓存是加速层，写失败不能改变已成功的服务器操作结果。
    cacheWriteQueue.catch(() => {});
  }

  function clearBusinessCache() {
    const pendingWrites = cacheWriteQueue.catch(() => {});
    cacheResetPromise = pendingWrites.then(async () => {
      try {
        const db = await openBusinessCache();
        await requestResult(db.transaction(BUSINESS_CACHE_STORE, 'readwrite').objectStore(BUSINESS_CACHE_STORE).clear());
        db.close();
      } catch (_) {
        // IndexedDB 不可用时仍应完成退出流程。
      }
      cacheDbPromise = null;
      if (!window.indexedDB) return;
      try {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(BUSINESS_CACHE_DB);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        });
      } catch (_) {
        // 删除数据库本身失败时，前面的 object store clear 仍已尽力清除业务数据。
      }
    });
    return cacheResetPromise;
  }

  // 拖拽结束后的时间戳：在其后 350ms 内吞掉系统 click，避免误触"点击卡片编辑"
  let dragSuppressUntil = 0;

  /* ------------------------------ 工具 ------------------------------ */

  const todayStr = () => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  };

  const formatDay = (dateStr) => String(dateStr || '').replaceAll('-', '.');

  // 会员到期剩余天数（当天算 0，已过期为负）
  const daysFromToday = (dateStr) => {
    if (!dateStr) return null;
    const today = todayStr();
    const ms = new Date(dateStr + 'T00:00:00') - new Date(today + 'T00:00:00');
    return Math.round(ms / 86400000);
  };

  const maskNumber = (number) => {
    const digits = String(number || '').replace(/\D/g, '');
    if (!digits) return '未填写卡号';
    // 保留首尾各四位，中间统一掩码。
    if (digits.length <= 8) return digits;
    return `${digits.slice(0, 4)} •••• ${digits.slice(-4)}`;
  };

  const formatGroups = (number) => String(number || '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');

  const money = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return `¥${num.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  };

  const dayLabel = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    if (num >= 1 && num <= 28) return `${num}日`;
    return '—';
  };

  const presetFor = (type, key) => {
    const list = type === 'bank' ? BANK_PRESETS : SITE_PRESETS;
    return list.find((item) => item.key === key) || null;
  };

  /* --------------------------- 渲染：登录页 --------------------------- */

  const renderLogin = () => {
    const app = $('#app');
    app.innerHTML = `
      <div class="login-screen">
        <div class="login-card">
          <img class="login-logo" src="/rabbit-wallet-192.png" alt="" width="88" height="88" />
          <h1>RabbitReminder</h1>
          <p class="login-sub">你的卡和会员，到期前会在这里</p>
          <form id="login-form">
            <div class="field">
              <input id="login-code" class="text-input" type="password" inputmode="text" autocomplete="off"
                     placeholder="输入访问口令" required autofocus />
            </div>
            ${session.error ? `<p class="form-error">${esc(session.error)}</p>` : ''}
            <button class="btn btn-primary btn-block" type="submit" ${session.busy ? 'disabled' : ''}>
              ${session.busy ? '验证中…' : '进入'}
            </button>
          </form>
        </div>
      </div>`;

    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = $('#login-code').value.trim();
      if (!code) return;
      session.busy = true;
      session.error = '';
      render();
      try {
        const result = await api('/api/session', { method: 'POST', body: JSON.stringify({ code }) });
        setAuthenticatedToken(result.token);
        await loadAll({ cacheFirst: true });
      } catch (error) {
        session.error = error.message;
      } finally {
        session.busy = false;
        render();
      }
    });
  };

  /* --------------------------- 渲染：主界面 --------------------------- */

  const headerMarkup = () => `
    <header class="app-header">
      <div class="header-main">
        <div class="header-brand">
          <img class="brand-icon" src="/rabbit-wallet-192.png" alt="" width="32" height="32" />
          <strong id="page-title">${state.tab === 'sites' ? '会员' : '卡片'}</strong>
        </div>
        <div class="header-actions">
          <button class="icon-btn" id="logout-btn" title="退出登录" aria-label="退出登录">${lineIcon('logout')}</button>
        </div>
      </div>
      <div id="header-summary" ${state.tab === 'cards' ? '' : 'hidden'}>${cardsSummaryMarkup()}</div>
    </header>`;

  const addLabel = () => (state.tab === 'sites' ? '新增网站会员' : '新增银行卡');

  const dockMarkup = () => `
    <nav class="dock" aria-label="主导航">
      <div class="dock-tabs glass" role="tablist" aria-label="分类">
        <button type="button" class="dock-tab ${state.tab === 'cards' ? 'active' : ''}" data-tab="cards" role="tab" aria-selected="${state.tab === 'cards'}">
          ${lineIcon('card')}<span>银行卡</span>${state.cards.length ? `<em>${state.cards.length}</em>` : ''}
        </button>
        <button type="button" class="dock-tab ${state.tab === 'sites' ? 'active' : ''}" data-tab="sites" role="tab" aria-selected="${state.tab === 'sites'}">
          ${lineIcon('pin')}<span>会员</span>${state.memberships.length ? `<em>${state.memberships.length}</em>` : ''}
        </button>
      </div>
      <button type="button" class="dock-add glass" id="add-btn" title="${addLabel()}" aria-label="${addLabel()}">${lineIcon('plus')}</button>
    </nav>`;

  const brandColor = (hex) => (/^#[0-9a-fA-F]{6}$/.test(String(hex || '')) ? hex : '#3b6bfa');
  const cardInk = (hex) => {
    const ink = textOn(brandColor(hex));
    return {
      ink,
      inkSoft: ink === '#ffffff' ? 'rgba(255,255,255,0.76)' : 'rgba(28,35,51,0.62)',
    };
  };

  const cardAvatar = (name, color, { onBrand = false } = {}) =>
    onBrand
      ? `<span class="card-avatar letter-avatar">${esc(firstChar(name))}</span>`
      : `<span class="card-avatar" style="background:${esc(color)};color:${textOn(color)}">${esc(firstChar(name))}</span>`;

  const BANK_LOGO_KEYS = new Set(['icbc', 'abc', 'boc', 'ccb', 'bocom', 'psbc', 'cmb', 'citic', 'cib', 'spdb', 'pingan', 'cmbc']);
  const bankAvatar = (card) => {
    const matched = BANK_LOGO_KEYS.has(card.bankKey)
      ? card.bankKey
      : BANK_PRESETS.find((bank) => bank.name === String(card.bankName || '').trim())?.key;
    if (!BANK_LOGO_KEYS.has(matched)) return cardAvatar(card.bankName, card.color, { onBrand: true });
    return `<span class="card-avatar bank-logo-avatar">
      <img src="/banks/${matched}.svg" alt="" width="28" height="28" loading="eager" />
    </span>`;
  };

  const lineIcon = (name) => {
    const paths = {
      eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
      hidden: '<path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3 3.8M6.1 6.1A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.9-1.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
      copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>',
      pin: '<path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.2"/>',
      logout: '<path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/><path d="M16 12H9"/><path d="m13 9 3 3-3 3"/>',
      grip: '<circle cx="9" cy="6.5" r="1.45"/><circle cx="15" cy="6.5" r="1.45"/><circle cx="9" cy="12" r="1.45"/><circle cx="15" cy="12" r="1.45"/><circle cx="9" cy="17.5" r="1.45"/><circle cx="15" cy="17.5" r="1.45"/>',
    };
    return `<svg class="action-icon${name === 'grip' ? ' filled' : ''}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${paths[name]}</svg>`;
  };

  const revealBtn = (card) => {
    const shown = state.reveal.has(card.id);
    const label = `${shown ? '隐藏' : '显示'}完整卡号`;
    return `<button class="reveal-btn" data-reveal="${card.id}" title="${label}" aria-label="${label}" aria-pressed="${shown}">${lineIcon(shown ? 'hidden' : 'eye')}</button>`;
  };

  // 一键复制完整卡号（去掉空格等分隔符，纯数字，便于支付/绑卡场景直接粘贴）
  const copyToClipboard = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    // 降级：非安全上下文或 API 被拒 → 隐藏 textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      const selection = document.getSelection();
      const prevRange = selection.rangeCount > 0 && selection.getRangeAt(0);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (prevRange) {
        selection.removeAllRanges();
        selection.addRange(prevRange);
      }
      return ok;
    } catch (_) {
      return false;
    }
  };

  // 卡号与详情共用左边缘，复制和查看使用独立的线性图标按钮。
  const cardNumberLine = (card) => {
    const shown = state.reveal.has(card.id);
    const text = shown ? formatGroups(card.number) : maskNumber(card.number);
    if (!String(card.number || '').replace(/\D/g, '')) return '';
    return `<div class="card-number ${shown ? 'revealed' : ''}">
      <span class="num-text">${esc(text)}</span>
      <button class="num-copy" data-copy="${card.id}" title="复制完整卡号" aria-label="复制完整卡号">${lineIcon('copy')}</button>
      ${revealBtn(card)}
    </div>`;
  };

  const creditMeta = (card) => {
    const display = (value) => value === null || value === undefined || String(value).trim() === '' ? '—' : String(value).trim();
    const details = [
      ['账单日', dayLabel(card.billingDay)],
      ['还款日', dayLabel(card.repaymentDay)],
      ['年费', display(card.annualFee)],
      ['权益', display(card.benefits)],
    ];
    return `<div class="meta-core credit-meta">
      <span>有效期 <b>${esc(display(card.expiry))}</b></span>
      <span>额度 <b>${money(card.limit)}</b></span>
      <button type="button" class="card-info" data-info="${card.id}" title="查看信用卡详情" aria-label="查看信用卡详情" aria-expanded="false">i</button>
      <div class="card-info-popover" data-info-panel="${card.id}" role="dialog" aria-label="信用卡详情" hidden>
        <dl>${details.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
      </div>
    </div>`;
  };

  const CARD_NETWORKS = [
    { value: '银联', file: 'unionpay', aliases: ['银联', '中国银联', 'unionpay'] },
    { value: 'Visa', file: 'visa', aliases: ['visa'] },
    { value: 'Mastercard', file: 'mastercard', aliases: ['mastercard', '万事达', '万事达卡'] },
    { value: '美国运通', file: 'amex', aliases: ['美国运通', '运通', 'ae', 'amex', 'americanexpress'] },
    { value: 'JCB', file: 'jcb', aliases: ['jcb'] },
  ];
  const normalizeCardNetwork = (value) => {
    const key = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    return CARD_NETWORKS.find((network) => network.aliases.includes(key))?.value || '';
  };
  const networkLogo = (value) => {
    const network = CARD_NETWORKS.find((item) => item.value === normalizeCardNetwork(value));
    return network ? `<img class="network-logo" src="/networks/${network.file}.svg" alt="${network.value}" title="${network.value}" width="48" height="24" />` : '';
  };

  const bankCardMarkup = (card, index) => {
    const color = brandColor(card.color);
    const ink = cardInk(color);
    const kind = card.type === 'credit' && card.kind
      ? `<span class="detail-tag" title="${esc(card.kind)}">${esc(card.kind)}</span>`
      : '';
    return `
    <article class="bank-card ${card.type === 'credit' ? 'credit-card' : 'debit-card'}" data-id="${card.id}" data-index="${index}"
             style="--card-color:${esc(color)};--card-ink:${ink.ink};--card-ink-soft:${ink.inkSoft}">
      <div class="bank-card-border">
        <span class="card-glow" aria-hidden="true"></span>
        <div class="bank-card-body">
          <div class="bank-card-title">
            ${bankAvatar(card)}
            <span class="bank-name" title="${esc(card.bankName)}">${esc(card.bankName)}</span>
            <span class="card-type-badge">${card.type === 'credit' ? '信用' : '借记'}</span>
            ${kind}
            ${networkLogo(card.network)}
          </div>
          ${cardNumberLine(card)}
          ${card.type === 'credit' ? creditMeta(card) : ''}
        </div>
        <button type="button" class="drag-handle" title="按住拖拽排序" aria-label="按住拖拽排序">${lineIcon('grip')}</button>
      </div>
    </article>`;
  };

  const daysBadge = (membership) => {
    const days = daysFromToday(membership.expiry);
    if (days === null) return '';
    const cls = days < 0 ? 'danger' : days === 0 ? 'warn' : days <= 30 ? 'warn' : 'ok';
    const label = days < 0 ? `已过期 ${-days} 天` : days === 0 ? '今天到期' : `剩 ${days} 天`;
    return `<span class="days-badge ${cls}">${label}</span>`;
  };

  const siteCardMarkup = (membership, index) => `
    <article class="site-card" data-id="${membership.id}" data-index="${index}"
             style="--card-color:${esc(brandColor(membership.color))}">
      <div class="site-card-border">
        ${cardAvatar(membership.siteName, membership.color)}
        <div class="site-card-body">
          <div class="site-card-title">
            <span class="site-name">${esc(membership.siteName)}</span>
            ${daysBadge(membership)}
          </div>
          <div class="site-expiry">到期日 <b>${esc(formatDay(membership.expiry))}</b></div>
        </div>
        <span class="chevron">›</span>
      </div>
    </article>`;

  const emptyMarkup = (type) => {
    const isCards = type === 'cards';
    return `<div class="empty-state">
      <img src="/rabbit-wallet-192.png" alt="" width="96" height="96" />
      <p>${isCards ? '还没有银行卡' : '还没有网站会员'}</p>
      <span>${isCards ? '把常用的卡收进这个钱包' : '到期前提醒，少一份遗忘'}</span>
      <button type="button" class="btn btn-primary" data-empty-add>${isCards ? '添加第一张卡' : '添加到期提醒'}</button>
    </div>`;
  };

  const skeletonMarkup = (type) => {
    const count = type === 'sites' ? 3 : 4;
    const cls = type === 'sites' ? 'skeleton-card skeleton-site' : 'skeleton-card';
    return `<div class="skeleton-list" aria-hidden="true">${Array.from({ length: count }, () => `<div class="${cls}"></div>`).join('')}</div>`;
  };

  const cardsSummaryMarkup = () => {
    const creditCards = state.cards.filter((card) => card.type === 'credit');
    const debitCount = state.cards.filter((card) => card.type === 'debit').length;
    const bankLimits = new Map();
    for (const card of creditCards) {
      // 同一家银行共享额度只计一次；记录不一致时取该银行最高额度。
      const bank = presetFor('bank', card.bankKey)?.name || String(card.bankName || '').trim();
      const limit = Number(card.limit);
      if (Number.isFinite(limit) && limit >= 0) {
        bankLimits.set(bank, Math.max(bankLimits.get(bank) || 0, limit));
      }
    }
    const total = [...bankLimits.values()].reduce((sum, limit) => sum + limit, 0);
    return `<p class="cards-summary" aria-label="银行卡汇总">
      <button type="button" class="summary-filter ${state.cardFilter === 'debit' ? 'active' : ''}" data-card-filter="debit" aria-pressed="${state.cardFilter === 'debit'}">借记卡 ${debitCount}</button>
      <button type="button" class="summary-filter credit-summary ${state.cardFilter === 'credit' ? 'active' : ''}" data-card-filter="credit" aria-pressed="${state.cardFilter === 'credit'}" title="同一家银行只计一次，取该银行最高信用额度"><span>信用卡 ${creditCards.length}</span><span class="summary-limit">总额度 ${total.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</span></button>
    </p>`;
  };

  const visibleCards = () => state.cards.filter((card) => !state.cardFilter || card.type === state.cardFilter);
  const cardsPanelMarkup = () => {
    if (state.loading && !state.cards.length) return skeletonMarkup('cards');
    const cards = visibleCards();
    const empty = state.cardFilter
      ? `<div class="empty-state"><p>暂无${state.cardFilter === 'credit' ? '信用卡' : '借记卡'}</p><span>再次点击上方筛选可查看全部</span></div>`
      : emptyMarkup('cards');
    return `<div id="cards-list">${cards.length ? cards.map(bankCardMarkup).join('') : empty}</div>`;
  };

  function renderCardsPanel() {
    $('#panel-cards').innerHTML = cardsPanelMarkup();
    $('#header-summary').innerHTML = cardsSummaryMarkup();
    initDragSort();
    equalizeCardHeights();
  }

  const mainMarkup = () => {
    const sitesBody = state.loading && !state.memberships.length
      ? skeletonMarkup('sites')
      : state.memberships.length
        ? state.memberships.map((membership, index) => siteCardMarkup(membership, index)).join('')
        : emptyMarkup('sites');
    return `
      ${headerMarkup()}
      <main class="list-area">
        <section class="list-panel ${state.tab === 'cards' ? 'active' : ''}" id="panel-cards">
          ${cardsPanelMarkup()}
        </section>
        <section class="list-panel ${state.tab === 'sites' ? 'active' : ''}" id="panel-sites">
          ${sitesBody}
        </section>
      </main>
      ${dockMarkup()}`;
  };

  /* ------------------------------ 事件绑定 ------------------------------ */

  const bindMainEvents = () => {
    $('#logout-btn').addEventListener('click', () => {
      invalidateSession();
    });

    $$('.dock-tab').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (state.tab === btn.dataset.tab) return;
        state.tab = btn.dataset.tab;
        $$('.dock-tab').forEach((tab) => {
          const active = tab.dataset.tab === state.tab;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-selected', String(active));
        });
        $('#panel-cards').classList.toggle('active', state.tab === 'cards');
        $('#panel-sites').classList.toggle('active', state.tab === 'sites');
        $('#header-summary').hidden = state.tab !== 'cards';
        const title = $('#page-title');
        if (title) title.textContent = state.tab === 'sites' ? '会员' : '卡片';
        const addBtn = $('#add-btn');
        if (addBtn) {
          const label = addLabel();
          addBtn.setAttribute('aria-label', label);
          addBtn.title = label;
        }
        if (state.tab === 'cards') equalizeCardHeights();
      }),
    );

    $('#header-summary').addEventListener('click', (event) => {
      const filter = event.target.closest('[data-card-filter]');
      if (filter) {
        state.cardFilter = state.cardFilter === filter.dataset.cardFilter ? null : filter.dataset.cardFilter;
        renderCardsPanel();
        return;
      }
    });

    $('#add-btn').addEventListener('click', () => openEditor(state.tab));

    // 委托事件：筛选或更新银行卡列表时保留页头与外层监听。
    $('#panel-cards').addEventListener('click', (event) => {
      // 刚结束一次拖拽时，浏览器会补发 click，这里吞掉避免误开编辑
      if (Date.now() < dragSuppressUntil) return;
      if (event.target.closest('[data-empty-add]')) {
        openEditor('cards');
        return;
      }
      const copyBtnClicked = event.target.closest('.num-copy');
      if (copyBtnClicked) {
        const id = Number(copyBtnClicked.dataset.copy);
        const card = state.cards.find((c) => c.id === id);
        const digits = card ? String(card.number || '').replace(/\D/g, '') : '';
        if (!digits) {
          toast('未填写卡号');
          return;
        }
        copyToClipboard(digits).then((ok) => {
          if (!ok) {
            toast('复制失败，请长按手动复制');
            return;
          }
          copyBtnClicked.classList.add('copied');
          copyBtnClicked.innerHTML = lineIcon('check');
          copyBtnClicked.setAttribute('aria-label', '已复制');
          setTimeout(() => {
            copyBtnClicked.classList.remove('copied');
            copyBtnClicked.innerHTML = lineIcon('copy');
            copyBtnClicked.setAttribute('aria-label', '复制完整卡号');
          }, 1200);
          toast('卡号已复制');
        });
        return;
      }
      const revealBtnClicked = event.target.closest('.reveal-btn');
      if (revealBtnClicked) {
        const id = Number(revealBtnClicked.dataset.reveal);
        const card = state.cards.find((item) => item.id === id);
        if (!card) return;
        const shown = !state.reveal.has(id);
        if (shown) state.reveal.add(id);
        else state.reveal.delete(id);
        // 只更新当前卡号和眼睛按钮，保留银行卡及 Logo 的 DOM。
        const line = revealBtnClicked.closest('.card-number');
        line.classList.toggle('revealed', shown);
        $('.num-text', line).textContent = shown ? formatGroups(card.number) : maskNumber(card.number);
        const label = `${shown ? '隐藏' : '显示'}完整卡号`;
        revealBtnClicked.title = label;
        revealBtnClicked.setAttribute('aria-label', label);
        revealBtnClicked.setAttribute('aria-pressed', String(shown));
        revealBtnClicked.innerHTML = lineIcon(shown ? 'hidden' : 'eye');
        if (card.type === 'debit') equalizeCardHeights();
        return;
      }
      const infoBtnClicked = event.target.closest('.card-info');
      if (infoBtnClicked) {
        const infoMeta = infoBtnClicked.closest('.credit-meta');
        const infoPanel = infoMeta && $('.card-info-popover', infoMeta);
        if (!infoMeta || !infoPanel) return;
        const open = infoBtnClicked.getAttribute('aria-expanded') === 'true';
        $$('.card-info[aria-expanded="true"]', $('#panel-cards')).forEach((button) => {
          button.setAttribute('aria-expanded', 'false');
          const panel = button.closest('.credit-meta') && $('.card-info-popover', button.closest('.credit-meta'));
          if (panel) panel.hidden = true;
          button.closest('.bank-card')?.classList.remove('info-open');
        });
        infoBtnClicked.setAttribute('aria-expanded', String(!open));
        infoPanel.hidden = open;
        if (!open) infoBtnClicked.closest('.bank-card')?.classList.add('info-open');
        return;
      }
      if (event.target.closest('.card-info-popover')) return;
      if (event.target.closest('.card-number')) return;
      const card = event.target.closest('.bank-card');
      if (card) openEditor('cards', Number(card.dataset.id));
    });

    $('#panel-sites').addEventListener('click', (event) => {
      if (event.target.closest('[data-empty-add]')) {
        openEditor('sites');
        return;
      }
      const card = event.target.closest('.site-card');
      if (card) openEditor('sites', Number(card.dataset.id));
    });

    initDragSort();
  };

  /* ---------------------------- 拖拽排序（卡片） ---------------------------- */

  // 仅从手柄开始拖拽。卡片跟随指针，原位置由占位元素保留。
  function initDragSort() {
    const panel = $('#cards-list');
    if (!panel) return;
    let drag = null;

    panel.addEventListener('pointerdown', (event) => {
      if (drag) return;
      const handle = event.target.closest('.drag-handle');
      const card = handle?.closest('.bank-card');
      if (!card) return;
      event.preventDefault();

      const rect = card.getBoundingClientRect();
      const originalStyle = card.getAttribute('style');
      const placeholder = document.createElement('div');
      placeholder.className = 'bank-card drag-placeholder';
      placeholder.style.height = `${rect.height}px`;
      card.before(placeholder);
      const pointerOffset = event.clientY - rect.top;
      document.body.appendChild(card);
      Object.assign(card.style, {
        position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
        margin: '0', zIndex: '50', transform: 'translate3d(0, 0, 0)',
      });
      card.classList.add('dragging');
      document.body.classList.add('sorting-cards');
      drag = { card, panel, placeholder, originalStyle, pointerId: event.pointerId, type: event.pointerType || 'mouse', pointerOffset };

      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
      window.addEventListener('blur', onEnd);
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onEnd, true);
      document.addEventListener('pointercancel', onEnd, true);
    });

    function animateList(before) {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      for (const item of drag.panel.querySelectorAll('.bank-card:not(.drag-placeholder)')) {
        const oldTop = before.get(item);
        if (oldTop === undefined) continue;
        const delta = oldTop - item.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.5) {
          item.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
            duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)',
          });
        }
      }
    }

    function onMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.type === 'mouse' && event.buttons === 0) return onEnd(event);
      event.preventDefault();
      drag.card.style.top = `${event.clientY - drag.pointerOffset}px`;

      const before = new Map([...drag.panel.querySelectorAll('.bank-card:not(.drag-placeholder)')]
        .map((item) => [item, item.getBoundingClientRect().top]));
      const after = getDragAfterElement(drag.panel, event.clientY);
      if (after == null) drag.panel.appendChild(drag.placeholder);
      else drag.panel.insertBefore(drag.placeholder, after);
      animateList(before);

      const edge = 88;
      if (event.clientY < edge + $('.app-header').offsetHeight) window.scrollBy({ top: -10, behavior: 'auto' });
      else if (event.clientY > innerHeight - edge) window.scrollBy({ top: 10, behavior: 'auto' });
    }

    function onEnd(event) {
      if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onEnd, true);
      document.removeEventListener('pointercancel', onEnd, true);
      window.removeEventListener('blur', onEnd);

      drag.placeholder.before(drag.card);
      drag.placeholder.remove();
      drag.card.classList.remove('dragging');
      if (drag.originalStyle === null) drag.card.removeAttribute('style');
      else drag.card.setAttribute('style', drag.originalStyle);
      document.body.classList.remove('sorting-cards');
      dragSuppressUntil = Date.now() + 350;
      drag = null;
      persistCardOrder();
    }
  }

  function getDragAfterElement(container, y) {
    const els = [...container.querySelectorAll('.bank-card:not(.dragging):not(.drag-placeholder)')];
    return els.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, element: child };
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null },
    ).element;
  }

  function mergeCardOrder(cards, visibleOrder) {
    const visibleIds = new Set(visibleOrder);
    let index = 0;
    return cards.map((card) => visibleIds.has(card.id) ? visibleOrder[index++] : card.id);
  }

  async function persistCardOrder() {
    const visibleOrder = $$('#cards-list .bank-card').map((card) => Number(card.dataset.id));
    if (!visibleOrder.length) return;
    // 筛选时只重排当前类型原有的位置，另一类卡片的顺序与位置保持不变。
    const ordered = mergeCardOrder(state.cards, visibleOrder);
    // 顺序没变（如轻触手柄）则不请求、不重绘
    if (ordered.join(',') === state.cards.map((card) => card.id).join(',')) return;
    const context = currentSession();
    try {
      await api('/api/cards/reorder', { method: 'POST', body: JSON.stringify({ ids: ordered }) });
      if (!isCurrentSession(context)) return;
      const byId = new Map(state.cards.map((card) => [card.id, card]));
      state.cards = ordered.map((id) => byId.get(id)).filter(Boolean);
      queueSnapshotWrite(context);
      renderCardsPanel();
    } catch (error) {
      if (!isCurrentSession(context)) return;
      toast(error.message);
      await loadCards(context).catch(() => {});
      if (!isCurrentSession(context)) return;
      renderCardsPanel();
    }
  }

  /* ------------------------------ 编辑表单 ------------------------------ */

  // color 相关：品牌预设色 + 常用色板
  const PALETTE = ['#3b6bfa', '#c7000b', '#00a550', '#d71920', '#0066b3', '#f36c21', '#8e24aa', '#00897b', '#5d4037', '#546e7a', '#000000'];

  const brandChips = (type, currentKey, fieldName) => {
    const list = type === 'bank' ? BANK_PRESETS : SITE_PRESETS;
    const current = presetFor(type, currentKey);
    const name = fieldName;
    return `
      <div class="preset-field">
        <label>${name}</label>
        <div class="preset-input-row">
          <input id="brand-name" list="${type === 'bank' ? 'bank-datalist' : 'site-datalist'}"
                 class="text-input" placeholder="选择或手动输入${type === 'bank' ? '银行' : '网站'}名称"
                 value="${esc(current?.name || '')}" autocomplete="off" />
          <datalist id="${type === 'bank' ? 'bank-datalist' : 'site-datalist'}">
            ${list.map((item) => `<option value="${esc(item.name)}"></option>`).join('')}
          </datalist>
          <input type="hidden" id="brand-key" value="${esc(currentKey || 'other')}" />
        </div>
        <div class="preset-chips" id="brand-chips">
          ${list
            .map(
              (item) => `
            <button type="button" class="brand-chip" data-key="${esc(item.key)}" data-name="${esc(item.name)}" data-color="${esc(item.color)}">
              <span class="chip-dot" style="background:${item.color}"></span>${esc(item.name)}
            </button>`,
            )
            .join('')}
          <button type="button" class="brand-chip chip-other" data-key="other">
            <span class="chip-dot" style="background:linear-gradient(135deg,#9aa4b8,#5c657a)"></span>其他
          </button>
        </div>
      </div>`;
  };

  const daySelect = (label, fieldName, value, name) => `
    <div class="field">
      <label>${label}</label>
      <select class="select-input" id="${fieldName}" name="${name}">
        <option value="">未设置</option>
        ${Array.from({ length: 28 }, (_, i) => {
          const day = i + 1;
          return `<option value="${day}" ${Number(value) === day ? 'selected' : ''}>${day}日</option>`;
        }).join('')}
      </select>
    </div>`;

  const colorRow = (color) => `
    <div class="field">
      <label>卡面颜色</label>
      <div class="color-row">
        ${PALETTE.map(
          (c) => `
          <button type="button" class="color-swatch ${String(color).toLowerCase() === c ? 'active' : ''}"
                  data-color="${c}" style="background:${c}" aria-label="${c}"></button>`,
        ).join('')}
        <label class="color-custom">
          <input type="color" id="color-picker" value="${esc(color)}" />
        </label>
      </div>
    </div>`;

  const cardFormMarkup = (card) => {
    const isEdit = Boolean(card?.id);
    const c = card || { type: 'credit', bankKey: '', bankName: '', color: '#3b6bfa', number: '', kind: '', network: '', expiry: '', limit: null, billingDay: null, repaymentDay: null, benefits: '', annualFee: '' };
    return `
      <form id="card-form" class="sheet-form">
        <div class="sheet-header">
          <h2>${isEdit ? '编辑银行卡' : '新增银行卡'}</h2>
          <button type="button" class="icon-btn sheet-close" data-close>✕</button>
        </div>
        <div class="type-switch">
          <button type="button" class="type-btn ${c.type === 'credit' ? 'active' : ''}" data-type="credit">信用卡</button>
          <button type="button" class="type-btn ${c.type === 'debit' ? 'active' : ''}" data-type="debit">借记卡</button>
        </div>
        ${brandChips('bank', c.bankKey, '银行')}
        <div class="field">
          <label>卡号</label>
          <input id="card-number" class="text-input mono" inputmode="numeric" autocomplete="off"
                 placeholder="请输入完整卡号（仅数字）" value="${esc(c.number)}" maxlength="24" />
        </div>
        <div class="field">
          <label>卡组织</label>
          <select id="card-network" class="select-input" aria-label="卡组织">
            <option value="">未设置</option>
            ${c.network && !normalizeCardNetwork(c.network) ? `<option value="${esc(c.network)}" selected disabled>原记录：${esc(c.network)}（请选择）</option>` : ''}
            ${CARD_NETWORKS.map(({ value }) => `<option value="${value}" ${normalizeCardNetwork(c.network) === value ? 'selected' : ''}>${value === '美国运通' ? '美国运通（AE）' : value}</option>`).join('')}
          </select>
        </div>
        <div id="credit-fields" ${c.type === 'debit' ? 'style="display:none"' : ''}>
          <div class="field">
            <label>卡种类</label>
            <input id="card-kind" class="text-input" list="kind-datalist" placeholder="如 金卡/白金卡" value="${esc(c.kind)}" autocomplete="off" />
            <datalist id="kind-datalist">
              ${['金卡', '白金卡', '钛金卡', '钻石卡', '黑金卡', '无限卡', '标准卡', '联名卡'].map((v) => `<option value="${v}"></option>`).join('')}
            </datalist>
          </div>
          <div class="field-row">
            <div class="field">
              <label>有效期（月/年）</label>
              <input id="card-expiry" class="text-input" placeholder="MM/YY，如 08/29" value="${esc(c.expiry)}" maxlength="7" autocomplete="off" inputmode="numeric" />
            </div>
            <div class="field">
              <label>额度（元）</label>
              <input id="card-limit" class="text-input" inputmode="decimal" placeholder="如 50000" value="${c.limit ?? ''}" autocomplete="off" />
            </div>
          </div>
          <div class="field-row">
            ${daySelect('账单日', 'card-billing', c.billingDay, 'billingDay')}
            ${daySelect('还款日', 'card-repayment', c.repaymentDay, 'repaymentDay')}
          </div>
          <div class="field">
            <label>年费规则</label>
            <input id="card-annual-fee" class="text-input" placeholder="如 免年费 / 消费6笔免年费 / 2000元/年" value="${esc(c.annualFee)}" />
          </div>
          <div class="field">
            <label>权益</label>
            <textarea id="card-benefits" class="text-input" rows="3" placeholder="如 机场贵宾厅、积分换礼…">${esc(c.benefits)}</textarea>
          </div>
        </div>
        ${colorRow(c.color)}
        <div class="sheet-actions">
          ${isEdit ? '<button type="button" class="btn btn-danger" id="delete-btn">删除</button>' : ''}
          <div class="sheet-actions-spacer"></div>
          <button type="button" class="btn" data-close>取消</button>
          <button type="submit" class="btn btn-primary">保存</button>
        </div>
      </form>`;
  };

  const siteFormMarkup = (membership) => {
    const isEdit = Boolean(membership?.id);
    const m = membership || { siteKey: '', siteName: '', color: '#3b6bfa', expiry: '' };
    return `
      <form id="site-form" class="sheet-form">
        <div class="sheet-header">
          <h2>${isEdit ? '编辑网站会员' : '新增网站会员'}</h2>
          <button type="button" class="icon-btn sheet-close" data-close>✕</button>
        </div>
        ${brandChips('site', m.siteKey, '网站名称')}
        <div class="field">
          <label>到期日</label>
          <input id="site-expiry" type="date" class="text-input" value="${esc(m.expiry || '')}" />
          <p class="field-hint">会员按到期日远近自动排序（过期优先置顶）</p>
        </div>
        ${colorRow(m.color)}
        <div class="sheet-actions">
          ${isEdit ? '<button type="button" class="btn btn-danger" id="delete-btn">删除</button>' : ''}
          <div class="sheet-actions-spacer"></div>
          <button type="button" class="btn" data-close>取消</button>
          <button type="submit" class="btn btn-primary">保存</button>
        </div>
      </form>`;
  };

  const openEditor = (tab, id = null) => {
    let html;
    if (tab === 'cards') {
      const card = id ? state.cards.find((item) => item.id === id) || null : null;
      html = cardFormMarkup(card);
    } else {
      const membership = id ? state.memberships.find((item) => item.id === id) || null : null;
      html = siteFormMarkup(membership);
    }
    const root = $('#sheet-root');
    root.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet">${html}</div>`;
    root.classList.add('open');

    // 关闭
    $$('[data-close]', root).forEach((btn) => btn.addEventListener('click', closeSheet));
    $('.sheet-backdrop', root).addEventListener('click', closeSheet);

    // 银行卡专属：类型切换
    const typeSwitch = $('.type-switch', root);
    if (typeSwitch) {
      $$('.type-btn', typeSwitch).forEach((btn) =>
        btn.addEventListener('click', () => {
          const type = btn.dataset.type;
          $$('.type-btn', typeSwitch).forEach((b) => b.classList.toggle('active', b === btn));
          $('#credit-fields').style.display = type === 'credit' ? '' : 'none';
        }),
      );
    }

    // 品牌 chips：点击自动填充名称 + 颜色
    const brandInput = $('#brand-name', root);
    const brandKeyInput = $('#brand-key', root);
    const type = tab === 'cards' ? 'bank' : 'site';
    if (brandInput) {
      $$('.brand-chip', root).forEach((chip) =>
        chip.addEventListener('click', () => {
          const key = chip.dataset.key;
          brandKeyInput.value = key || 'other';
          if (key === 'other') {
            brandInput.value = '';
            brandInput.focus();
            return;
          }
          brandInput.value = chip.dataset.name;
          setColor(chip.dataset.color || '#3b6bfa', root);
        }),
      );
      // 手动输入匹配到预设品牌时给出品牌色提示
      brandInput.addEventListener('input', () => {
        const name = brandInput.value.trim();
        const match = (type === 'bank' ? BANK_PRESETS : SITE_PRESETS).find((item) => item.name === name);
        brandKeyInput.value = match ? match.key : 'other';
        if (match) setColor(match.color, root);
      });
      brandInput.addEventListener('keydown', (event) => {
        // 阻止 datalist 选择后回车提交表单
        if (event.key === 'Enter') event.preventDefault();
      });
    }

    // 有效期输入：自动整理为 MM/YY
    const expiryInput = $('#card-expiry', root);
    if (expiryInput) {
      expiryInput.addEventListener('input', () => {
        let digits = expiryInput.value.replace(/\D/g, '').slice(0, 4);
        if (digits.length > 2) digits = `${digits.slice(0, 2)}/${digits.slice(2)}`;
        expiryInput.value = digits;
      });
    }

    // 色板
    const colorPicker = $('#color-picker', root);
    if (colorPicker) {
      $$('.color-swatch', root).forEach((sw) =>
        sw.addEventListener('click', () => setColor(sw.dataset.color, root)),
      );
      colorPicker.addEventListener('input', () => setColor(colorPicker.value, root, true));
    }

    const form = $('.sheet-form', root);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const context = currentSession();
      try {
        if (tab === 'cards') await submitCardForm(id, context);
        else await submitSiteForm(id, context);
        if (!isCurrentSession(context)) return;
        closeSheet();
        render();
      } catch (error) {
        if (!isCurrentSession(context)) return;
        toast(error.message);
      }
    });

    const deleteBtn = $('#delete-btn', root);
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const kind = tab === 'cards' ? '这张银行卡' : '这个会员记录';
        if (!confirm(`确认删除${kind}？此操作不可恢复。`)) return;
        const context = currentSession();
        try {
          if (tab === 'cards') await api(`/api/cards/${id}`, { method: 'DELETE' });
          else await api(`/api/memberships/${id}`, { method: 'DELETE' });
          if (!isCurrentSession(context)) return;
          if (tab === 'cards') {
            state.cards = state.cards.filter((item) => item.id !== id);
            state.reveal.delete(id);
          } else {
            state.memberships = state.memberships.filter((item) => item.id !== id);
          }
          queueSnapshotWrite(context);
          closeSheet();
          render();
        } catch (error) {
          if (!isCurrentSession(context)) return;
          toast(error.message);
        }
      });
    }

    // 聚焦
    setTimeout(() => brandInput?.focus(), 50);
  };

  const setColor = (color, root, force = false) => {
    const hex = String(color).replace(/[^#\dA-Fa-f]/g, '');
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    const normalized = hex.toLowerCase();
    const picker = $('#color-picker', root);
    if (picker) picker.value = normalized;
    $$('.color-swatch', root).forEach((sw) => sw.classList.toggle('active', sw.dataset.color === normalized));
    // 实时预览：需要卡片色联动到编辑中表单不好预览，仅记录
    root.dataset.pickedColor = normalized;
  };

  const closeSheet = () => {
    const root = $('#sheet-root');
    root.classList.remove('open');
    root.innerHTML = '';
  };

  /* ------------------------------ 表单提交 ------------------------------ */

  const submitCardForm = async (id, context) => {
    const typeBtn = $('.type-btn.active');
    const type = typeBtn ? typeBtn.dataset.type : 'credit';
    const payload = {
      card_type: type,
      bank_key: $('#brand-key').value || 'other',
      bank_name: $('#brand-name').value.trim(),
      color: $('#color-picker').value,
      card_number: $('#card-number').value,
      card_network: $('#card-network').value,
    };
    if (type === 'credit') {
      payload.card_kind = $('#card-kind').value.trim();
      payload.expiry_date = $('#card-expiry').value.trim();
      payload.credit_limit = $('#card-limit').value === '' ? null : Number($('#card-limit').value);
      payload.billing_day = $('#card-billing').value === '' ? null : Number($('#card-billing').value);
      payload.repayment_day = $('#card-repayment').value === '' ? null : Number($('#card-repayment').value);
      payload.annual_fee = $('#card-annual-fee').value.trim();
      payload.benefits = $('#card-benefits').value.trim();
    }
    if (!payload.bank_name) throw new Error('请填写银行名称');
    if (!payload.card_number.trim()) throw new Error('请填写卡号');
    const { item } = id
      ? await api(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/cards', { method: 'POST', body: JSON.stringify(payload) });
    if (!isCurrentSession(context)) return;
    if (item && typeof item === 'object') {
      state.cards = id
        ? state.cards.map((card) => card.id === id ? item : card)
        : [...state.cards, item];
      state.cards.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || Number(a.id) - Number(b.id));
      queueSnapshotWrite(context);
    }
    // mutation 已成功且本地快照已同步；校准 GET 失败不应把保存表现为失败。
    await loadCards(context).catch(() => {});
  };

  const submitSiteForm = async (id, context) => {
    const payload = {
      site_key: $('#brand-key').value || 'other',
      site_name: $('#brand-name').value.trim(),
      color: $('#color-picker').value,
      expiry_date: $('#site-expiry').value,
    };
    if (!payload.site_name) throw new Error('请填写网站名称');
    if (!payload.expiry_date) throw new Error('请选择到期日');
    const { item } = id
      ? await api(`/api/memberships/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/memberships', { method: 'POST', body: JSON.stringify(payload) });
    if (!isCurrentSession(context)) return;
    if (item && typeof item === 'object') {
      state.memberships = id
        ? state.memberships.map((membership) => membership.id === id ? item : membership)
        : [...state.memberships, item];
      const today = todayStr();
      state.memberships.sort((a, b) =>
        Number(b.expiry < today) - Number(a.expiry < today)
        || String(a.expiry).localeCompare(String(b.expiry))
        || Number(a.id) - Number(b.id));
      queueSnapshotWrite(context);
    }
    // mutation 已成功且本地快照已同步；校准 GET 失败不应把保存表现为失败。
    await loadMemberships(context).catch(() => {});
  };

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadCards(context = currentSession()) {
    const { items } = await api('/api/cards');
    if (!isCurrentSession(context)) return;
    if (!Array.isArray(items)) throw new Error('银行卡数据格式异常');
    state.cards = items;
    queueSnapshotWrite(context);
  }

  async function loadMemberships(context = currentSession()) {
    const { items } = await api('/api/memberships');
    if (!isCurrentSession(context)) return;
    if (!Array.isArray(items)) throw new Error('会员数据格式异常');
    state.memberships = items;
    queueSnapshotWrite(context);
  }

  async function loadAll({ cacheFirst = false } = {}) {
    const context = currentSession();
    if (!isCurrentSession(context)) return;
    state.loading = true;
    render();
    let cached = null;
    if (cacheFirst) {
      cached = await readCachedSnapshot(context);
      if (!isCurrentSession(context)) return;
      if (cached) {
        state.cards = cached.cards;
        state.memberships = cached.memberships;
        state.loading = false;
        render();
      }
    }

    const results = await Promise.allSettled([loadCards(context), loadMemberships(context)]);
    if (!isCurrentSession(context)) return;
    state.loading = false;
    render();

    const failed = results.find((result) => result.status === 'rejected');
    if (!failed) return;
    if (cached) toast('网络不可用，已显示本地数据');
    else toast(failed.reason?.message || '数据加载失败，请稍后重试');
  }

  /* ------------------------------ Toast ------------------------------ */

  let toastTimer = null;
  function toast(message) {
    const root = $('#toast-root');
    root.innerHTML = `<div class="toast">${esc(message)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (root.innerHTML = ''), 2800);
  }

  /* ------------------------------ 渲染入口 ------------------------------ */

  function render() {
    if (!session.token) {
      renderLogin();
      return;
    }
    const app = $('#app');
    app.innerHTML = mainMarkup();
    bindMainEvents();
    equalizeCardHeights();
  }

  // 借记卡按实际最高内容等高；信用卡随内容自然撑高；缩放、旋转屏幕时重新计算，不裁切详情。
  function equalizeCardHeights() {
    for (const type of ['debit']) {
      const cards = $$(`.${type}-card .bank-card-border`);
      cards.forEach((card) => { card.style.height = ''; });
      const height = Math.ceil(Math.max(0, ...cards.map((card) => card.getBoundingClientRect().height)));
      if (height) cards.forEach((card) => { card.style.height = `${height}px`; });
    }
  }
  let listWidth = 0;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === listWidth) return;
    listWidth = entry.contentRect.width;
    equalizeCardHeights();
  }).observe($('#app'));
  document.fonts.ready.then(equalizeCardHeights);

  // 保留单指滚动，阻止页面捏合缩放（包括 Safari 的手势事件）。
  for (const type of ['gesturestart', 'gesturechange']) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
  document.addEventListener('touchmove', (event) => {
    if (event.touches.length > 1) event.preventDefault();
  }, { passive: false });
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey) event.preventDefault();
  }, { passive: false });

  // 更新缓存不自动刷新页面；用户主动应用新版，避免丢失表单输入。
  if ('serviceWorker' in navigator) {
    const updates = $('#update-notice');
    let checking = false;
    let lastCheck = 0;

    function inspectController() {
      const worker = navigator.serviceWorker.controller;
      if (!worker) return;
      const channel = new MessageChannel();
      const timeout = setTimeout(() => channel.port1.close(), 3000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timeout);
        channel.port1.close();
        if (worker !== navigator.serviceWorker.controller || data?.type !== 'VERSION') return;
        updates.hidden = !data.version || data.version === APP_VERSION;
      };
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    }

    $('#apply-update').addEventListener('click', () => {
      if ($('#sheet-root').classList.contains('open') || session.busy) {
        toast('请先保存或关闭当前表单，再更新');
        return;
      }
      if (!navigator.onLine) {
        toast('请联网后更新');
        return;
      }
      window.location.reload();
    });

    navigator.serviceWorker.addEventListener('controllerchange', inspectController);
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
      async function checkForUpdate(force = false) {
        if (!navigator.onLine || document.visibilityState === 'hidden' || checking) return;
        if (!force && Date.now() - lastCheck < 60_000) return;
        checking = true;
        lastCheck = Date.now();
        try {
          await registration.update();
          // 也检查已被其他窗口激活的新版，或后台期间错过的更新。
          if (!registration.installing) inspectController();
        } catch (_) {
          // 更新检查失败不影响正常使用；下次联网或回到前台再检查。
        } finally {
          checking = false;
        }
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
      window.addEventListener('online', () => checkForUpdate(true));
      window.addEventListener('pageshow', () => checkForUpdate());
      // 长时间停留前台也能发现发布；后台不轮询。
      setInterval(() => checkForUpdate(), 5 * 60_000);
      checkForUpdate(true);
    }).catch(() => {});
  }

  // 首次进入：有 token 先保持加载态并尝试本地快照，再在后台刷新。
  if (session.token) state.loading = true;
  render();
  if (session.token) void loadAll({ cacheFirst: true });
})();
