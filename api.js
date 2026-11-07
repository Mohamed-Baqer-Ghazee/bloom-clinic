// Bloom — shared helpers for booking, queue and reception pages
window.Bloom = (() => {
  const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
  const STATUS = {
    booked:     { label: 'محجوز',        tone: 'mint' },
    confirmed:  { label: 'مؤكّد',        tone: 'teal' },
    arrived:    { label: 'وصلت',         tone: 'coral' },
    in_session: { label: 'بالجلسة',      tone: 'deep' },
    done:       { label: 'انتهت',        tone: 'grey' },
    no_show:    { label: 'ما حضرت',      tone: 'grey' },
    cancelled:  { label: 'ملغي',         tone: 'grey' },
  };

  async function api(path, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Admin-Token'] = token;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('ما گدرنا نتصل بالسيرفر. تأكدي إنه شغّال.'), { status: 0 });
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'صار خطأ، حاولي مرة ثانية'), { status: res.status });
    return data;
  }

  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };

  function fmtTime(t) {
    if (!t) return '';
    let [h, m] = t.split(':').map(Number);
    const suffix = h < 12 ? 'صباحاً' : h < 13 ? 'ظهراً' : 'مساءً';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
  }

  function relDay(s, today = isoDate(new Date())) {
    if (s === today) return 'اليوم';
    if (s === addDays(today, 1)) return 'باچر';
    return DAYS[parseDate(s).getDay()];
  }

  function longDate(s) {
    const d = parseDate(s);
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderDays(el, days, selected, onPick, today) {
    el.innerHTML = days.map(s => {
      const d = parseDate(s);
      return `<button type="button" class="day${s === selected ? ' sel' : ''}" data-day="${s}" aria-pressed="${s === selected}">
        <small>${relDay(s, today)}</small><strong>${d.getDate()}</strong><small>${MONTHS[d.getMonth()]}</small></button>`;
    }).join('');
    el.querySelectorAll('.day').forEach(b => b.addEventListener('click', () => onPick(b.dataset.day)));
  }

  function renderSlots(el, slots, selected, onPick) {
    if (!slots.length) { el.innerHTML = '<p class="hint">ماكو أوقات فارغة بهذا اليوم، جربي يوم ثاني.</p>'; return; }
    const groups = [['الصبح', slots.filter(t => t < '12:00')], ['الظهر والعصر', slots.filter(t => t >= '12:00' && t < '17:00')], ['المسا', slots.filter(t => t >= '17:00')]];
    el.innerHTML = groups.filter(g => g[1].length).map(([label, list]) => `
      <div class="slot-group"><span class="slot-label">${label}</span><div class="slot-grid">
      ${list.map(t => `<button type="button" class="slot${t === selected ? ' sel' : ''}" data-time="${t}" aria-pressed="${t === selected}">${fmtTime(t)}</button>`).join('')}
      </div></div>`).join('');
    el.querySelectorAll('.slot').forEach(b => b.addEventListener('click', () => onPick(b.dataset.time)));
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  function waLink(phone, text) {
    const intl = '964' + String(phone).replace(/^0/, '');
    return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
  }

  function confirmationText(b, doctor, baseUrl) {
    const first = (b.first_name || b.name || '').split(' ')[0];
    return `هلا ${first}،\nموعدك تأكّد يوم ${longDate(b.date)} الساعة ${fmtTime(b.time)} مع ${doctor}.\nتگدرين تتابعين دورك مباشرة من الرابط:\n${baseUrl}/q/${b.code}`;
  }

  return { api, STATUS, DAYS, MONTHS, parseDate, isoDate, addDays, fmtTime, relDay, longDate, esc, renderDays, renderSlots, store, waLink, confirmationText };
})();
