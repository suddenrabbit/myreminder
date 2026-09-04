/* ============================================================
 * RabbitReminder PWA 前端
 * 两个 Tab：
 *   1) 银行卡：借记卡(银行/卡号) / 信用卡(+种类/有效期/额度/组织/账单日/还款日/权益/年费)
 *      卡片拖拽排序、点击编辑、左侧银行首字大圆、可调边框色
 *   2) 网站会员：网站名/到期日，按到期远近自动排序（不可手工排序）
 * 数据通过 Cloudflare Worker API 存 D1；本地口令登录。
 * ============================================================ */

(() => {
  'use strict';

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
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (session.token) headers.Authorization = `Bearer ${session.token}`;
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      session.token = '';
      localStorage.removeItem('mr_token');
      render();
      throw new Error(payload.error || '登录已失效');
    }
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload;
  };

  /* ------------------------------ 状态 ------------------------------ */

  const session = { token: localStorage.getItem('mr_token') || '', busy: false, error: '' };
  const state = {
    tab: 'cards', // 'cards' | 'sites'
    cards: [],
    memberships: [],
    reveal: new Set(), // 已展开完整卡号的 card id
    loading: false,
  };

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
          <img class="login-logo" src="/rabbit-wallet-192.png" alt="" width="72" height="72" />
          <h1>RabbitReminder</h1>
          <p class="login-sub">银行卡 · 网站会员到期提醒</p>
          <form id="login-form">
            <div class="field">
              <input id="login-code" type="password" inputmode="text" autocomplete="off"
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
        session.token = result.token;
        localStorage.setItem('mr_token', result.token);
        await loadAll();
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
      <div class="header-brand">
        <img class="brand-icon" src="/rabbit-wallet-192.png" alt="" width="30" height="30" />
        <strong>RabbitReminder</strong>
      </div>
      <div class="header-count">
        <button class="icon-btn" id="logout-btn" title="退出登录" aria-label="退出登录">⏻</button>
      </div>
    </header>`;

  const tabsMarkup = () => `
    <nav class="tab-bar" aria-label="主导航">
      <button class="tab-btn ${state.tab === 'cards' ? 'active' : ''}" data-tab="cards" aria-current="${state.tab === 'cards' ? 'page' : 'false'}">
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/></svg>
        <span>银行卡 ${state.cards.length ? `<em>${state.cards.length}</em>` : ''}</span>
      </button>
      <button class="tab-btn ${state.tab === 'sites' ? 'active' : ''}" data-tab="sites" aria-current="${state.tab === 'sites' ? 'page' : 'false'}">
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="m7 9 2 6h6l2-6-3 2-2-4-2 4z"/></svg>
        <span>网站会员 ${state.memberships.length ? `<em>${state.memberships.length}</em>` : ''}</span>
      </button>
    </nav>`;

  const cardAvatar = (name, color) => `
    <span class="card-avatar" style="background:${esc(color)};color:${textOn(color)}">${esc(firstChar(name))}</span>`;

  const revealBtn = (card) => {
    const shown = state.reveal.has(card.id);
    return `<button class="reveal-btn" data-reveal="${card.id}" title="${shown ? '隐藏' : '显示'}完整卡号">${shown ? '🙈' : '👁'}</button>`;
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

  // 第二行卡号：整行点击复制完整号（大热区，适合手机）；右侧 👁 展开/收起完整号
  const cardNumberLine = (card) => {
    const shown = state.reveal.has(card.id);
    const text = shown ? formatGroups(card.number) : maskNumber(card.number);
    const digits = String(card.number || '').replace(/\D/g, '');
    if (!digits) {
      return '';
    }
    return `<div class="card-number">
      <button class="num-copy ${shown ? 'revealed' : ''}" data-copy="${card.id}" title="点击复制完整卡号">
        <span class="num-text">${esc(text)}</span>
        <span class="copy-hint">复制</span>
      </button>
      ${revealBtn(card)}
    </div>`;
  };

  // 连续行内文本，用完可用宽度后自然换行，包括长年费和权益。
  const creditMeta = (card) => {
    const fields = [
      ['有效期', card.expiry, esc],
      ['额度', card.limit, money],
      ['账单日', card.billingDay, dayLabel],
      ['还款日', card.repaymentDay, dayLabel],
      ['年费', card.annualFee, esc],
      ['权益', card.benefits, esc],
    ]
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
      .map(([label, value, format]) => `${label} <b>${format(value)}</b>`);
    return fields.length ? `<div class="meta-line">${fields.join(' · ')}</div>` : '';
  };

  const bankCardMarkup = (card, index) => `
    <article class="bank-card ${card.type === 'credit' ? 'credit-card' : 'debit-card'}" data-id="${card.id}" data-index="${index}"
             style="--card-color:${esc(card.color)}">
      <div class="bank-card-border" style="border-color:${esc(card.color)}">
        ${cardAvatar(card.bankName, card.color)}
        <div class="bank-card-body">
          <div class="bank-card-title">
            <span class="bank-name" title="${esc(card.bankName)}">${esc(card.bankName)}</span>
            <span class="type-tag ${card.type}">${card.type === 'credit' ? '信用卡' : '借记卡'}</span>
            ${card.type === 'credit' ? [card.kind, card.network].filter(Boolean).map((tag) => `<span class="detail-tag" title="${esc(tag)}">${esc(tag)}</span>`).join('') : ''}
          </div>
          ${cardNumberLine(card)}
          ${card.type === 'credit' ? creditMeta(card) : ''}
        </div>
        <span class="drag-handle" title="拖拽排序">⠿</span>
      </div>
    </article>`;

  const daysBadge = (membership) => {
    const days = daysFromToday(membership.expiry);
    if (days === null) return '';
    const cls = days < 0 ? 'danger' : days === 0 ? 'warn' : days <= 30 ? 'warn' : 'ok';
    const label = days < 0 ? `已过期 ${-days} 天` : days === 0 ? '今天到期' : `剩 ${days} 天`;
    return `<span class="days-badge ${cls}">${label}</span>`;
  };

  const siteCardMarkup = (membership, index) => `
    <article class="site-card" data-id="${membership.id}" data-index="${index}"
             style="--card-color:${esc(membership.color)}">
      <div class="site-card-border" style="border-color:${esc(membership.color)}">
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
    const text =
      type === 'cards'
        ? '还没有银行卡<br />点击右下角 + 新增一张'
        : '还没有网站会员<br />点击右下角 + 添加到期提醒';
    return `<div class="empty-state">${text}</div>`;
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
      <span>借记卡 ${debitCount} 张</span><span>信用卡 ${creditCards.length} 张</span>
      <span title="同一家银行只计一次，取该银行最高信用额度">总额度 ${total.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 元</span>
    </p>`;
  };

  const mainMarkup = () => {
    if (state.loading) return `<div class="center-hint">加载中…</div>`;
    const cardsBody = state.cards.length
      ? state.cards.map((card, index) => bankCardMarkup(card, index)).join('')
      : emptyMarkup('cards');
    const sitesBody = state.memberships.length
      ? state.memberships.map((membership, index) => siteCardMarkup(membership, index)).join('')
      : emptyMarkup('sites');
    return `
      ${headerMarkup()}
      <main class="list-area">
        <section class="list-panel ${state.tab === 'cards' ? 'active' : ''}" id="panel-cards">
          ${cardsSummaryMarkup()}
          ${cardsBody}
        </section>
        <section class="list-panel ${state.tab === 'sites' ? 'active' : ''}" id="panel-sites">
          ${sitesBody}
        </section>
      </main>
      ${tabsMarkup()}
      <button class="fab" id="fab-btn" title="新增">＋</button>`;
  };

  /* ------------------------------ 事件绑定 ------------------------------ */

  const bindMainEvents = () => {
    $('#logout-btn').addEventListener('click', () => {
      session.token = '';
      localStorage.removeItem('mr_token');
      render();
    });

    $$('.tab-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.tab = btn.dataset.tab;
        render();
      }),
    );

    $('#fab-btn').addEventListener('click', () => openEditor(state.tab));

    // 点击卡片 → 编辑；点击眼睛 → 展开完整卡号；点击 📋 → 一键复制卡号
    $('#panel-cards').addEventListener('click', (event) => {
      // 刚结束一次拖拽时，浏览器会补发 click，这里吞掉避免误开编辑
      if (Date.now() < dragSuppressUntil) return;
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
          const hint = copyBtnClicked.querySelector('.copy-hint');
          if (!ok) {
            toast('复制失败，请长按手动复制');
            return;
          }
          copyBtnClicked.classList.add('copied');
          if (hint) hint.textContent = '已复制';
          setTimeout(() => {
            copyBtnClicked.classList.remove('copied');
            if (hint) hint.textContent = '复制';
          }, 1200);
          toast('卡号已复制');
        });
        return;
      }
      const revealBtnClicked = event.target.closest('.reveal-btn');
      if (revealBtnClicked) {
        const id = Number(revealBtnClicked.dataset.reveal);
        if (state.reveal.has(id)) state.reveal.delete(id);
        else state.reveal.add(id);
        render();
        return;
      }
      const card = event.target.closest('.bank-card');
      if (card) openEditor('cards', Number(card.dataset.id));
    });

    $('#panel-sites').addEventListener('click', (event) => {
      const card = event.target.closest('.site-card');
      if (card) openEditor('sites', Number(card.dataset.id));
    });

    initDragSort();
  };

  /* ---------------------------- 拖拽排序（卡片） ---------------------------- */

  // 桌面鼠标 + 移动触摸通用拖拽（基于 Pointer Events）
  function initDragSort() {
    const panel = $('#panel-cards');
    if (!panel) return;

    let drag = null;

    // 从卡片任意位置按下都能进入拖拽预备；move/up/cancel 挂到 window，
    // 指针移到任何位置都不丢事件（不依赖 setPointerCapture 是否生效）
    panel.addEventListener('pointerdown', (event) => {
      // 已经在一张卡的拖拽中则忽略第二根手指/第二次按下
      if (drag) return;
      const card = event.target.closest('.bank-card');
      if (!card) return;
      // 眼睛/复制按钮不作为拖动起点
      if (event.target.closest('.reveal-btn, .num-copy')) return;

      const handle = event.target.closest('.drag-handle');
      // 仅手柄起点阻止默认行为（防误触滚动/长按菜单）。
      // 卡片主体保留原生默认 → 系统 click 正常生成，「点击卡片=编辑」不受影响
      // （文本选择已由 CSS user-select:none 处理）
      if (handle) event.preventDefault();
      drag = {
        card,
        panel,
        handle,
        pointerId: event.pointerId,
        type: event.pointerType || 'mouse',
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        // 从手柄按下视为意图拖拽（立即跟手）；从卡片主体按下需位移 > 8px
        moved: !!handle,
      };
      if (drag.moved) drag.card.classList.add('dragging');
      try { event.target.setPointerCapture(event.pointerId); } catch (_) {}
      // 兜底：拖拽中页面失焦（切后台 / 鼠标在窗口外松开）也结束拖拽，防止卡片残留半透明
      window.addEventListener('blur', onEnd);
      // 监听挂 document 捕获阶段：无论指针移到哪个元素、capture 是否生效，
      // move/up 都能第一时间收到（pointer 事件天然走捕获与冒泡，捕获层最稳）
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onEnd, true);
      document.addEventListener('pointercancel', onEnd, true);
    });

    function onMove(event) {
      if (!drag) return;
      // 鼠标已松开但 pointerup 丢失（如窗口外松手）：主动结束，避免卡片残留半透明
      if (drag.type === 'mouse' && drag.moved && event.buttons === 0) {
        onEnd();
        return;
      }
      // 拖拽期间视图被重绘则放弃本次拖拽，避免把游离卡片插回新列表
      if (!drag.card.isConnected) {
        onEnd();
        return;
      }
      if (!drag.moved) {
        // 从卡片主体开始：位移超过阈值才认定为拖拽（否则视为点击编辑）
        if (Math.abs(event.clientY - drag.startY) < 8) return;
        drag.moved = true;
        drag.card.classList.add('dragging');
      }
      // 在 DOM 上搬动卡片，让其他卡片顺位
      const after = getDragAfterElement(drag.panel, event.clientY);
      if (after == null) drag.panel.appendChild(drag.card);
      else drag.panel.insertBefore(drag.card, after);
      drag.lastY = event.clientY;
    }

    function onEnd() {
      if (!drag) return;
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onEnd, true);
      document.removeEventListener('pointercancel', onEnd, true);
      window.removeEventListener('blur', onEnd);
      if (drag.moved) {
        // 先移除被拖卡片，再兜底清理面板内任何残留的 .dragging（防引用错位/异常路径漏清）
        const panel = drag.panel;
        drag.card.classList.remove('dragging');
        if (panel && panel.querySelectorAll) {
          panel.querySelectorAll('.bank-card.dragging').forEach((el) => el.classList.remove('dragging'));
        }
        dragSuppressUntil = Date.now() + 350; // 吞掉随后的系统 click，避免误开编辑
        persistCardOrder();
      }
      drag = null;
    }
  }

  function getDragAfterElement(container, y) {
    const els = [...container.querySelectorAll('.bank-card:not(.dragging)')];
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

  async function persistCardOrder() {
    const ordered = $$('#panel-cards .bank-card').map((card) => Number(card.dataset.id));
    if (!ordered.length) return;
    // 顺序没变（如轻触手柄）则不请求、不重绘
    if (ordered.join(',') === state.cards.map((card) => card.id).join(',')) return;
    try {
      await api('/api/cards/reorder', { method: 'POST', body: JSON.stringify({ ids: ordered }) });
      const byId = new Map(state.cards.map((card) => [card.id, card]));
      state.cards = ordered.map((id) => byId.get(id)).filter(Boolean);
      render();
    } catch (error) {
      toast(error.message);
      await loadCards();
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
      <label>卡片边框色</label>
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
        <div id="credit-fields" ${c.type === 'debit' ? 'style="display:none"' : ''}>
          <div class="field-row">
            <div class="field">
              <label>卡种类</label>
              <input id="card-kind" class="text-input" list="kind-datalist" placeholder="如 金卡/白金卡" value="${esc(c.kind)}" autocomplete="off" />
              <datalist id="kind-datalist">
                ${['金卡', '白金卡', '钛金卡', '钻石卡', '黑金卡', '无限卡', '标准卡', '联名卡'].map((v) => `<option value="${v}"></option>`).join('')}
              </datalist>
            </div>
            <div class="field">
              <label>卡组织</label>
              <input id="card-network" class="text-input" list="network-datalist" placeholder="如 银联" value="${esc(c.network)}" autocomplete="off" />
              <datalist id="network-datalist">
                ${['银联', 'Visa', 'Mastercard', '美国运通', 'JCB'].map((v) => `<option value="${v}"></option>`).join('')}
              </datalist>
            </div>
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
      try {
        if (tab === 'cards') await submitCardForm(id);
        else await submitSiteForm(id);
        closeSheet();
        render();
      } catch (error) {
        toast(error.message);
      }
    });

    const deleteBtn = $('#delete-btn', root);
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const kind = tab === 'cards' ? '这张银行卡' : '这个会员记录';
        if (!confirm(`确认删除${kind}？此操作不可恢复。`)) return;
        try {
          if (tab === 'cards') await api(`/api/cards/${id}`, { method: 'DELETE' });
          else await api(`/api/memberships/${id}`, { method: 'DELETE' });
          closeSheet();
          await loadAll();
        } catch (error) {
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

  const submitCardForm = async (id) => {
    const typeBtn = $('.type-btn.active');
    const type = typeBtn ? typeBtn.dataset.type : 'credit';
    const payload = {
      card_type: type,
      bank_key: $('#brand-key').value || 'other',
      bank_name: $('#brand-name').value.trim(),
      color: $('#color-picker').value,
      card_number: $('#card-number').value,
    };
    if (type === 'credit') {
      payload.card_kind = $('#card-kind').value.trim();
      payload.card_network = $('#card-network').value.trim();
      payload.expiry_date = $('#card-expiry').value.trim();
      payload.credit_limit = $('#card-limit').value === '' ? null : Number($('#card-limit').value);
      payload.billing_day = $('#card-billing').value === '' ? null : Number($('#card-billing').value);
      payload.repayment_day = $('#card-repayment').value === '' ? null : Number($('#card-repayment').value);
      payload.annual_fee = $('#card-annual-fee').value.trim();
      payload.benefits = $('#card-benefits').value.trim();
    }
    if (!payload.bank_name) throw new Error('请填写银行名称');
    if (!payload.card_number.trim()) throw new Error('请填写卡号');
    if (id) await api(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/cards', { method: 'POST', body: JSON.stringify(payload) });
    await loadCards();
  };

  const submitSiteForm = async (id) => {
    const payload = {
      site_key: $('#brand-key').value || 'other',
      site_name: $('#brand-name').value.trim(),
      color: $('#color-picker').value,
      expiry_date: $('#site-expiry').value,
    };
    if (!payload.site_name) throw new Error('请填写网站名称');
    if (!payload.expiry_date) throw new Error('请选择到期日');
    if (id) await api(`/api/memberships/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/memberships', { method: 'POST', body: JSON.stringify(payload) });
    await loadMemberships();
  };

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadCards() {
    const { items } = await api('/api/cards');
    state.cards = items;
  }

  async function loadMemberships() {
    const { items } = await api('/api/memberships');
    state.memberships = items;
  }

  async function loadAll() {
    state.loading = true;
    render();
    try {
      await Promise.all([loadCards(), loadMemberships()]);
    } finally {
      state.loading = false;
      render();
    }
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
    if (!state.loading) {
      bindMainEvents();
      equalizeCardHeights();
    }
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

  // 注册 Service Worker（PWA 离线缓存）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }

  // 首次进入：有 token 直接拉数据；无 token 走登录页
  render();
  if (session.token) loadAll().catch((error) => toast(error.message));
})();
