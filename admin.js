// Bloom — reception dashboard (/admin)
(() => {
  const { api, STATUS, fmtTime, longDate, relDay, addDays, isoDate, esc, waLink, confirmationText } = Bloom;
  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'bloom-admin-token';
  const ss = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }, del: k => { try { sessionStorage.removeItem(k); } catch {} } };

  let token = ss.get(TOKEN_KEY);
  let day = isoDate(new Date());
  let data = { bookings: [] }, config = null, filter = 'active', query = '', started = false;
  const clinicToday = () => (config && config.today) || isoDate(new Date());

  const NEXT_ACTIONS = {
    booked:     [['arrived', 'وصلت'], ['no_show', 'ما حضرت'], ['cancelled', 'إلغاء']],
    confirmed:  [['arrived', 'وصلت'], ['no_show', 'ما حضرت'], ['cancelled', 'إلغاء']],
    arrived:    [['in_session', 'دخّليها'], ['cancelled', 'إلغاء']],
    in_session: [['done', 'انتهت الجلسة']],
    done:       [['in_session', 'تراجع']],
    no_show:    [['booked', 'إرجاع']],
    cancelled:  [['booked', 'إرجاع']],
  };

  function showLogin(msg) {
    $('dash').hidden = true; $('logout').hidden = true; $('login').hidden = false;
    $('loginErr').textContent = msg || ''; $('loginErr').hidden = !msg;
    $('pin').focus();
  }

  $('login').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      ({ token } = await api('/api/admin/login', { method: 'POST', body: { pin: $('pin').value } }));
      ss.set(TOKEN_KEY, token); $('pin').value = '';
      start();
    } catch (err) { showLogin(err.message); }
  });
  $('logout').addEventListener('click', () => { ss.del(TOKEN_KEY); token = null; showLogin(); });

  async function start() {
    $('login').hidden = true; $('dash').hidden = false; $('logout').hidden = false;
    config ||= await api('/api/config');
    if (!started) { day = config.today; started = true; }
    $('wService').innerHTML = '<option value="">العلاج…</option>' + config.services.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    load();
  }

  async function load() {
    try {
      data = await api('/api/admin/bookings?date=' + day, { token });
      render();
    } catch (e) {
      if (e.status === 401) { ss.del(TOKEN_KEY); showLogin(e.message); }
      else toast(e.message);
    }
  }

  function render() {
    const today = clinicToday();
    $('dayTitle').textContent = day === today ? 'مواعيد اليوم' : relDay(day, today) === 'باچر' ? 'مواعيد باچر' : 'المواعيد';
    $('daySub').textContent = longDate(day);
    $('callNext').hidden = day !== today;
    $('walkinBtn').hidden = day !== today;

    const b = data.bookings;
    const count = st => b.filter(x => st.includes(x.status)).length;
    $('stats').innerHTML = [
      ['كل المواعيد', b.filter(x => x.status !== 'cancelled').length, ''],
      ['بالانتظار', count(['booked', 'confirmed', 'arrived']), 'coral'],
      ['وصلت', count(['arrived']), ''],
      ['بالجلسة', count(['in_session']), 'deep'],
      ['انتهت', count(['done']), ''],
      ['ما حضرت', count(['no_show']), ''],
    ].map(([l, v, tone]) => `<div class="stat ${tone}"><strong>${v}</strong><span>${l}</span></div>`).join('');

    const q = query.trim().toLowerCase();
    const rows = b.filter(x => {
      if (filter === 'active' && !['booked', 'confirmed', 'arrived', 'in_session'].includes(x.status)) return false;
      if (filter === 'closed' && !['done', 'no_show', 'cancelled'].includes(x.status)) return false;
      return !q || x.name.toLowerCase().includes(q) || x.phone.includes(q) || x.code.toLowerCase().includes(q);
    });

    $('list').innerHTML = rows.length ? rows.map(x => {
      const st = STATUS[x.status];
      const msg = confirmationText(x, data.doctor, data.public_url);
      return `<article class="adm-row s-${x.status}">
        <div class="adm-time"><strong>${fmtTime(x.time)}</strong><small>${x.minutes} د</small></div>
        <div class="adm-who">
          <strong>${esc(x.name)} <span class="code-chip">${x.code}</span>${x.source === 'walkin' ? ' <span class="tag-mini">حضوري</span>' : ''}</strong>
          <span>${esc(x.service_name)}</span>
          <a href="tel:${x.phone}" dir="ltr" class="adm-phone">${x.phone}</a>
          ${x.notes ? `<em class="adm-notes">${esc(x.notes)}</em>` : ''}
        </div>
        <span class="pill ${st.tone}">${st.label}</span>
        <div class="adm-acts">
          ${NEXT_ACTIONS[x.status].map(([s, l]) => `<button class="btn btn-sm ${s === 'cancelled' || s === 'no_show' ? 'btn-text' : 'btn-outline'}" data-code="${x.code}" data-s="${s}">${l}</button>`).join('')}
          <a class="btn btn-sm btn-wa" href="${waLink(x.phone, msg)}" target="_blank" rel="noopener" title="إرسال التأكيد على واتساب">واتساب</a>
        </div>
      </article>`;
    }).join('') : `<p class="adm-empty">${b.length ? 'ماكو مواعيد بهذا الفلتر.' : 'ماكو مواعيد بهذا اليوم.'}</p>`;

    $('list').querySelectorAll('[data-s]').forEach(btn => btn.addEventListener('click', () => setStatus(btn.dataset.code, btn.dataset.s)));
  }

  async function setStatus(code, status) {
    try { await api(`/api/admin/bookings/${code}/status`, { method: 'POST', body: { status }, token }); load(); }
    catch (e) { if (e.status === 401) showLogin(e.message); else toast(e.message); }
  }

  $('callNext').addEventListener('click', () => {
    const waiting = data.bookings.filter(x => ['arrived', 'confirmed', 'booked'].includes(x.status));
    const next = waiting.find(x => x.status === 'arrived') || waiting[0];
    if (!next) return toast('ماكو أحد بالانتظار');
    setStatus(next.code, 'in_session');
    toast(`تفضلي ${next.name.split(' ')[0]} (${next.code})`);
  });

  $('prevDay').addEventListener('click', () => { day = addDays(day, -1); load(); });
  $('nextDay').addEventListener('click', () => { day = addDays(day, 1); load(); });
  $('todayBtn').addEventListener('click', () => { day = clinicToday(); load(); });

  $('admFilters').querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    $('admFilters').querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); filter = c.dataset.f; render();
  }));
  $('search').addEventListener('input', e => { query = e.target.value; render(); });

  $('walkinBtn').addEventListener('click', () => { $('walkin').hidden = false; $('wName').focus(); });
  $('walkinCancel').addEventListener('click', () => { $('walkin').hidden = true; });
  $('walkin').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const b = await api('/api/admin/walkin', { method: 'POST', token, body: { service: $('wService').value, name: $('wName').value, phone: $('wPhone').value } });
      $('walkin').reset(); $('walkin').hidden = true;
      toast(`انضافت ${b.name.split(' ')[0]} الساعة ${fmtTime(b.time)} (${b.code})`);
      load();
    } catch (err) { toast(err.message); }
  });

  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
  }

  setInterval(() => { if (token && !document.hidden && !$('dash').hidden) load(); }, 20000);
  token ? start().catch(() => showLogin()) : showLogin();
})();
