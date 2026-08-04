const API = '';

function $(sel) { return document.querySelector(sel); }
function money(cents, currency) {
  const n = (Number(cents || 0) / 100).toFixed(2);
  return `${currency} ${n}`;
}
function token() { return localStorage.getItem('vr_token') || ''; }

// ---- Status i18n labels ----
const STATUS_LABELS = {
  // inventory
  sourcing: '采购中', optimizing: '优化中', ready: '可售',
  reserved: '已锁定', sold: '已售出', suspended: '已停用',
  recycling: '回收中', retired: '已淘汰',
  // order
  pending_payment: '待支付', paid: '已支付', provisioning: '交付中',
  completed: '已完成', wait_stock: '待补货', cancelled: '已取消',
  refunded: '已退款', failed: '失败',
  // service
  pending: '待交付', active: '运行中', expired: '已到期',
  // payment / generic
  success: '成功', manual: '手动',
};
function statusLabel(s) { return STATUS_LABELS[String(s || '').toLowerCase()] || s || '-'; }
function statusBadge(s) { return `<span class="badge ${s}">${statusLabel(s)}</span>`; }
function setAuth(data) {
  localStorage.setItem('vr_token', data.accessToken || '');
  localStorage.setItem('vr_user', JSON.stringify(data.user || {}));
  // refresh cached identity in background for nav chip
  refreshUserNav();
}
function clearAuth() {
  localStorage.removeItem('vr_token');
  localStorage.removeItem('vr_user');
  refreshUserNav();
}
function currentUser() {
  try { return JSON.parse(localStorage.getItem('vr_user') || '{}'); } catch { return {}; }
}

// ---- Captcha ----
let _captchaId = '';
async function refreshCaptcha() {
  const img = document.getElementById('captchaImg');
  if (!img) return;
  try {
    const c = await api('/api/auth/captcha');
    _captchaId = c.id || '';
    img.innerHTML = c.svg || '';
    const code = document.getElementById('captchaCode');
    if (code) code.value = '';
  } catch (e) {
    img.innerHTML = '<span class="muted-text">验证码加载失败</span>';
  }
}

// ---- User nav chip ----
async function refreshUserNav() {
  const slot = document.getElementById('userSlot');
  if (!slot) return;
  if (!token()) { slot.innerHTML = ''; return; }
  let me = currentUser();
  // try to fetch fresh identity (best-effort, non-blocking)
  api('/api/auth/me').then(u => {
    if (u && u.id) {
      localStorage.setItem('vr_user', JSON.stringify(u));
      renderChip(u);
    }
  }).catch(() => renderChip(me));
  renderChip(me);
}
function renderChip(u) {
  const slot = document.getElementById('userSlot');
  if (!slot) return;
  if (!u || !u.email) { slot.innerHTML = ''; return; }
  const name = u.displayName || u.email.split('@')[0];
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const isAdmin = u.role === 'admin';
  slot.innerHTML = `<details class="user-menu">
    <summary class="user-chip">
      <span class="user-avatar">${initial}</span>
      <span class="user-name">${escapeHtml(name)}</span>
      <span class="caret">▾</span>
    </summary>
    <div class="menu-drop">
      <a href="/profile.html">资料设置</a>
      ${isAdmin ? '<a href="/admin.html">管理后台</a>' : ''}
      <a href="/services.html">我的服务</a>
      <a href="#" onclick="clearAuth(); location.href='/login.html'; return false;">退出</a>
    </div>
  </details>`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const res = await fetch(API + path, { ...opts, headers });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.message || data.error || text || res.statusText;
    throw new Error(Array.isArray(msg) ? msg.join(', ') : msg);
  }
  return data;
}
function showMsg(el, text, type = '') {
  if (!el) return;
  el.className = 'msg' + (type ? ' ' + type : '');
  el.textContent = text || '';
}

async function loadPlans() {
  const box = $('#planList');
  if (!box) return;
  try {
    const plans = await api('/api/plans');
    if (!plans.length) {
      box.innerHTML = '<div class="card">暂无上架套餐，请稍后或联系管理员。</div>';
      return;
    }
    box.innerHTML = plans.map(p => {
      const prices = (p.prices || []).map(pr =>
        `<span class="price-pill">${pr.currency}<em>${money(pr.priceCents, '').trim()}</em>/月</span>`
      ).join('');
      const cny = (p.prices || []).find(x => x.currency === 'CNY');
      const usd = (p.prices || []).find(x => x.currency === 'USD');
      return `<article class="card">
        <div class="region">${p.regionLabel || '精选节点'}</div>
        <h3>${p.name}</h3>
        <div class="desc">${p.description || '优化节点，月付订阅，支付后自动交付'}</div>
        <div class="specs">
          <div><b>${p.cpu} vCPU</b>计算核心</div>
          <div><b>${(p.memoryMb >= 1024 ? (p.memoryMb/1024).toFixed(p.memoryMb % 1024 ? 1 : 0) + ' GB' : p.memoryMb + ' MB')}</b>内存</div>
          <div><b>${p.diskGb} GB</b>系统盘</div>
          <div><b>${p.bandwidthLabel || '-'}</b>带宽</div>
        </div>
        <div class="price-row">${prices || '<span class="price-pill">未定价</span>'}</div>
        <div class="actions">
          ${cny ? `<button class="btn primary" onclick="buyPlan('${p.id}','CNY')">CNY 购买</button>` : ''}
          ${usd ? `<button class="btn good" onclick="buyPlan('${p.id}','USD')">USD 购买</button>` : ''}
        </div>
      </article>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<div class="card">加载失败：${e.message}</div>`;
  }
}

async function buyPlan(planId, currency) {
  if (!token()) {
    location.href = '/login.html?next=/' + encodeURIComponent(`#buy:${planId}:${currency}`);
    return;
  }
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ planId, currency }),
    });
    localStorage.setItem('vr_last_order', order.orderNo);
    // 跳转支付选择页：ABA KHQR / ABA PayWay / 虚拟币
    location.href = '/pay/checkout.html?orderNo=' + encodeURIComponent(order.orderNo);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes('OUT_OF_STOCK') || msg.toLowerCase().includes('out of stock')) {
      alert('下单失败：当前套餐无 ready 库存，请先在后台录入并标记 ready。');
    } else {
      alert('下单失败：' + msg);
    }
  }
}

async function loginFormSubmit(ev) {
  ev.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const captchaCode = $('#captchaCode')?.value?.trim() || '';
  const msg = $('#msg');
  if (!captchaCode) { showMsg(msg, '请输入验证码', 'err'); return; }
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, captchaId: _captchaId, captchaCode }),
    });
    setAuth(data);
    showMsg(msg, '登录成功，正在跳转…', 'ok');
    const q = new URLSearchParams(location.search);
    const next = q.get('next') || (data.user?.role === 'admin' ? '/admin.html' : '/services.html');
    setTimeout(() => location.href = next, 400);
  } catch (e) {
    showMsg(msg, e.message, 'err');
    refreshCaptcha();
  }
}

async function registerFormSubmit(ev) {
  ev.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const displayName = $('#displayName')?.value?.trim();
  const captchaCode = $('#captchaCode')?.value?.trim() || '';
  const msg = $('#msg');
  if (!captchaCode) { showMsg(msg, '请输入验证码', 'err'); return; }
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName, captchaId: _captchaId, captchaCode }),
    });
    setAuth(data);
    showMsg(msg, '注册成功', 'ok');
    setTimeout(() => location.href = '/services.html', 400);
  } catch (e) {
    showMsg(msg, e.message, 'err');
    refreshCaptcha();
  }
}

async function loadServices() {
  const box = $('#serviceList');
  if (!box) return;
  if (!token()) {
    box.innerHTML = '<div class="card">请先 <a href="/login.html">登录</a></div>';
    return;
  }
  try {
    const rows = await api('/api/services');
    if (!rows.length) {
      box.innerHTML = '<div class="card">暂无服务。<a href="/#plans">去购买</a></div>';
      return;
    }
    box.innerHTML = `<table class="table"><thead><tr>
      <th>服务号</th><th>套餐</th><th>IP / 配置</th><th>状态</th><th>到期</th><th>操作</th>
    </tr></thead><tbody>
    ${rows.map(s => {
      const sum = s.summary || {};
      const d = s.deliverPayloadJson || {};
      const ip = sum.ip || d.ip || '-';
      const conf = s.inventoryServer
        ? `${s.inventoryServer.cpu}C/${s.inventoryServer.memoryMb}M/${s.inventoryServer.diskGb}G`
        : '-';
      return `<tr>
        <td>${s.serviceNo}</td>
        <td>${s.plan?.name || s.planId}<div class="muted-text">${sum.region || ''} ${sum.provider || ''}</div></td>
        <td>${ip}<div class="muted-text">${conf}</div></td>
        <td>${statusBadge(s.status)}</td>
        <td>${(s.expireAt || '').replace('T',' ').slice(0,19)}</td>
        <td>
          <a class="btn sm primary" href="/service.html?id=${s.id}">进入控制台</a>
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
  } catch (e) {
    box.innerHTML = `<div class="card">加载失败：${e.message}</div>`;
  }
}

async function renewService(id, currency) {
  try {
    const order = await api(`/api/services/${id}/renew`, {
      method: 'POST',
      body: JSON.stringify({ currency }),
    });
    localStorage.setItem('vr_last_order', order.orderNo);
    location.href = '/pay/checkout.html?orderNo=' + encodeURIComponent(order.orderNo);
  } catch (e) {
    alert(e.message);
  }
}

// admin helpers
async function requireAdmin() {
  if (!token()) {
    location.href = '/login.html?next=/admin.html';
    return null;
  }
  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'admin') throw new Error('需要管理员账号');
    return me;
  } catch (e) {
    alert(e.message);
    location.href = '/login.html?next=/admin.html';
    return null;
  }
}

async function adminLoadInventory() {
  const box = $('#invTable');
  if (!box) return;
  const rows = await api('/api/admin/inventory');
  box.innerHTML = `<table class="table"><thead><tr>
    <th>ID</th><th>编号</th><th>驱动</th><th>IP</th><th>配置</th><th>地区</th><th>状态</th><th>绑定</th><th>操作</th>
  </tr></thead><tbody>
  ${rows.map(r => {
    const bind = r.reservedOrderId
      ? `<span class="muted-text">订单 #${r.reservedOrderId}</span>`
      : r.soldServiceId
        ? `<a href="/admin-service.html?id=${r.soldServiceId}" class="muted-text">服务 #${r.soldServiceId}</a>`
        : '-';
    return `<tr>
    <td>${r.id}</td><td>${r.code}<div class="muted-text">${r.providerRef || ''}</div></td>
    <td>${r.driver || r.provider}</td><td>${r.ip}:${r.sshPort}</td>
    <td>${r.cpu}C/${r.memoryMb}M/${r.diskGb}G</td><td>${r.region}</td>
    <td>${statusBadge(r.status)}</td>
    <td>${bind}</td>
    <td>${adminInvActions(r)}</td>
  </tr>`;
  }).join('') || '<tr><td colspan="9">暂无库存</td></tr>'}
  </tbody></table>`;
}

// Build context-aware action buttons based on the inventory state machine.
function adminInvActions(r) {
  const st = String(r.status || '').toLowerCase();
  const isPve = r.driver === 'proxmox' || r.provider === 'proxmox';
  const btn = (label, cls, fn) =>
    `<button class="btn sm ${cls || ''}" onclick="${fn}">${label}</button>`;
  const actions = [];
  if (isPve) {
    actions.push(btn('测连', '', `adminTestInv('${r.id}')`));
  }
  const T = {
    sourcing: [['optimizing', ''], ['retired', 'danger']],
    optimizing: [['ready', 'primary'], ['retired', 'danger']],
    ready: [['optimizing', ''], ['retired', 'danger']],
    reserved: [['ready', '']],
    sold: [['suspended', ''], ['recycling', '']],
    suspended: [['sold', 'primary'], ['recycling', '']],
    recycling: [['ready', 'primary'], ['retired', 'danger']],
    retired: [],
  };
  const transitions = T[st] || [];
  const labels = {
    optimizing: '优化中', ready: '标为 ready', retired: '淘汰',
    suspended: '停用', recycling: '回收', sold: '恢复售出',
  };
  for (const [next, cls] of transitions) {
    const lab = labels[next] || next;
    actions.push(btn(lab, cls, `adminSetStatus('${r.id}','${next}')`));
  }
  return actions.join(' ');
}

async function adminTestInv(id) {
  try {
    const res = await api(`/api/admin/inventory/${id}/test-connection`, { method: 'POST', body: '{}' });
    alert('连接成功\\n' + JSON.stringify(res, null, 2));
  } catch (e) {
    alert('连接失败：' + e.message);
  }
}

async function adminSetStatus(id, status) {
  await api(`/api/admin/inventory/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
  await adminLoadInventory();
}

async function adminCreateInventory(ev) {
  ev.preventDefault();
  const provider = ($('#provider').value || 'ssh').trim();
  const body = {
    code: $('#code').value.trim(),
    provider,
    ip: $('#ip').value.trim(),
    sshPort: Number($('#sshPort').value || 22),
    username: $('#username').value.trim() || 'root',
    password: $('#password').value,
    cpu: Number($('#cpu').value || 1),
    memoryMb: Number($('#memoryMb').value || 1024),
    diskGb: Number($('#diskGb').value || 20),
    region: $('#region').value.trim(),
    optimizeTags: ($('#tags').value || '').split(',').map(s => s.trim()).filter(Boolean),
    status: 'ready',
  };
  if (provider === 'proxmox') {
    body.providerRef = `${($('#pveNode').value || '').trim()}/${($('#pveVmid').value || '').trim()}`;
    body.pve = {
      host: ($('#pveHost').value || '').trim(),
      port: Number($('#pvePort').value || 8006),
      node: ($('#pveNode').value || '').trim(),
      vmid: Number($('#pveVmid').value || 0),
      tokenId: ($('#pveTokenId').value || '').trim() || undefined,
      tokenSecret: ($('#pveTokenSecret').value || '').trim() || undefined,
      templateVmid: $('#pveTemplate').value ? Number($('#pveTemplate').value) : undefined,
      storage: ($('#pveStorage').value || '').trim() || undefined,
      ipconfig0: ($('#pveIpconfig').value || '').trim() || undefined,
      nameserver: ($('#pveDns').value || '').trim() || undefined,
      apiUsername: ($('#pveApiUser').value || '').trim() || undefined,
      apiPassword: ($('#pveApiPass').value || '').trim() || undefined,
      ciUser: body.username,
      verifyTls: false,
    };
  }
  const msg = $('#msg');
  try {
    await api('/api/admin/inventory', { method: 'POST', body: JSON.stringify(body) });
    showMsg(msg, '库存已添加', 'ok');
    ev.target.reset();
    if ($('#provider')) $('#provider').value = provider;
    if (typeof toggleProviderFields === 'function') toggleProviderFields();
    await adminLoadInventory();
  } catch (e) {
    showMsg(msg, e.message, 'err');
  }
}

async function adminLoadOrders() {
  const box = $('#orderTable');
  if (!box) return;
  const rows = await api('/api/admin/orders');
  box.innerHTML = `<table class="table"><thead><tr>
    <th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>时间</th><th>操作</th>
  </tr></thead><tbody>
  ${rows.map(o => `<tr>
    <td>${o.orderNo}</td>
    <td>${o.user?.email || o.userId}</td>
    <td>${o.plan?.name || o.planId}</td>
    <td>${money(o.amountCents, o.currency)}</td>
    <td>${statusBadge(o.status)}</td>
    <td>${(o.createdAt||'').replace('T',' ').slice(0,19)}</td>
    <td><button class="btn sm" onclick="adminRetry('${o.id}')">重试分配</button></td>
  </tr>`).join('') || '<tr><td colspan="7">暂无订单</td></tr>'}
  </tbody></table>`;
}

async function adminRetry(id) {
  try {
    await api(`/api/admin/orders/${id}/retry-allocate`, { method: 'POST' });
    alert('已触发重试');
    await adminLoadOrders();
  } catch (e) {
    alert(e.message);
  }
}

async function adminCreatePlan(ev) {
  ev.preventDefault();
  const msg = $('#msg');
  const body = {
    name: $('#name').value.trim(),
    slug: $('#slug').value.trim(),
    regionLabel: $('#regionLabel').value.trim(),
    cpu: Number($('#cpu').value),
    memoryMb: Number($('#memoryMb').value),
    diskGb: Number($('#diskGb').value),
    bandwidthLabel: $('#bandwidthLabel').value.trim(),
    description: $('#description').value.trim(),
    matchRulesJson: {
      regions: ($('#matchRegions').value || '').split(',').map(s => s.trim()).filter(Boolean),
      min_cpu: Number($('#cpu').value),
      min_memory_mb: Number($('#memoryMb').value),
    },
    prices: [
      { currency: 'CNY', priceCents: Math.round(Number($('#priceCny').value) * 100) },
      { currency: 'USD', priceCents: Math.round(Number($('#priceUsd').value) * 100) },
    ],
  };
  try {
    await api('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) });
    showMsg(msg, '套餐已创建', 'ok');
    ev.target.reset();
  } catch (e) {
    showMsg(msg, e.message, 'err');
  }
}

window.loadPlans = loadPlans;
window.buyPlan = buyPlan;
window.loginFormSubmit = loginFormSubmit;
window.registerFormSubmit = registerFormSubmit;
window.loadServices = loadServices;
window.renewService = renewService;
window.requireAdmin = requireAdmin;
window.adminLoadInventory = adminLoadInventory;
window.adminSetStatus = adminSetStatus;
window.adminCreateInventory = adminCreateInventory;
window.adminTestInv = adminTestInv;
window.adminLoadOrders = adminLoadOrders;
window.adminRetry = adminRetry;
window.adminCreatePlan = adminCreatePlan;
window.clearAuth = clearAuth;
window.api = api;
window.currentUser = currentUser;
