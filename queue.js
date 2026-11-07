// Bloom — live queue / my-appointment page  (/q/CODE)
(() => {
  const { api, fmtTime, longDate, relDay, esc, store, renderDays, renderSlots, STATUS } = Bloom;
  const code = (location.pathname.match(/\/q\/([A-Za-z]\d{2,4})/) || [])[1]?.toUpperCase();
  const card = document.getElementById('qCard');
  const p4Key = 'bloom-p4-' + code;
  let booking = null, config = null, timer = null;

  if (!code) { card.innerHTML = '<p class="hint center">الرابط غير صحيح.</p>'; return; }

  card.innerHTML = `
    <div id="qStatus"></div>
    <dl class="q-details" id="qDetails"></dl>
    <div class="q-actions" id="qActions"></div>
    <div class="q-panel" id="qPanel" hidden></div>`;
  const $ = id => document.getElementById(id);

  async function load() {
    try {
      booking = await api('/api/q/' + code);
      render();
    } catch (e) {
      card.innerHTML = `<div class="q-state"><h1>${e.status === 404 ? 'ما لگينا الحجز' : 'صار خطأ'}</h1><p>${esc(e.message)}</p><a class="btn btn-coral" href="/#book">احجزي موعد</a></div>`;
      clearInterval(timer);
    }
  }

  function ring(value, progress, small) {
    const r = 54, c = 2 * Math.PI * r;
    return `<div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="${r}" class="ring-bg"/>
      <circle cx="60" cy="60" r="${r}" class="ring-fg" style="stroke-dasharray:${c};stroke-dashoffset:${c * (1 - progress)}"/></svg>
      <div class="ring-val"><strong>${value}</strong><small>${small}</small></div></div>`;
  }

  function render() {
    const b = booking, q = b.queue, s = b.status;
    const pill = `<span class="pill ${STATUS[s].tone}">${STATUS[s].label}</span>`;
    let html = `<div class="q-hello"><h1>هلا ${esc(b.first_name)}،</h1>${pill}</div>`;

    if (s === 'cancelled') {
      html += `<div class="q-state"><p>هذا الموعد ملغي. نتمنى نشوفك قريباً.</p><a class="btn btn-coral" href="/#book">احجزي موعد جديد</a></div>`;
    } else if (s === 'done') {
      html += `<div class="q-state"><p>شكراً لزيارتك! نتمنى الجلسة عجبتك، وبشرتك تتفتّح.</p><a class="btn btn-coral" href="/#book">احجزي الجلسة الجاية</a></div>`;
    } else if (s === 'no_show') {
      html += `<div class="q-state"><p>فاتك الموعد هالمرة. ولا يهمك، احجزي وقت ثاني يناسبك.</p><a class="btn btn-coral" href="/#book">احجزي من جديد</a></div>`;
    } else if (q && q.in_session) {
      html += `<div class="q-live now">${ring('<span class="ring-word">هسه</span>', 1, 'دورك')}<div><h2>دورك هسه!</h2><p>تفضلي لغرفة العلاج، الدكتورة بانتظارك.</p></div></div>`;
    } else if (q) {
      const a = q.ahead;
      const title = a === 0 ? 'إنتي التالية!' : `قدامك ${a} ${a === 1 ? 'مراجعة' : a === 2 ? 'مراجعتين' : 'مراجعين'}`;
      const tip = s === 'arrived' ? 'سجّلنا وصولك، استريحي وراح نناديچ.' : 'لما توصلين، بلّغي الاستقبال برقم الحجز.';
      html += `<div class="q-live">${a === 0 ? ring('<span class="ring-word">التالية</span>', 1, 'استعدي') : ring(a, 1 / (a + 1), 'قدامك')}
        <div><h2>${title}</h2><p>الوقت المتوقع لدخولك <strong>${fmtTime(q.est_time)}</strong></p><p class="muted small">${tip}</p>
        <p class="live-dot"><span class="pulse"></span>يتحدّث تلقائياً</p></div></div>`;
    } else {
      html += `<div class="q-live future"><div class="q-date"><small>موعدك</small><strong>${relDay(b.date)}</strong><span>${fmtTime(b.time)}</span></div>
        <div><p>يوم موعدك، هذا الرابط يصير مباشر ويبيّنلك دورك لحظة بلحظة.</p></div></div>`;
    }
    $('qStatus').innerHTML = html;

    $('qDetails').innerHTML = [
      ['رقم الحجز', `<span class="code-chip">${b.code}</span>`],
      ['العلاج', esc(b.service)],
      ['اليوم', longDate(b.date)],
      ['الوقت', `${fmtTime(b.time)} · ${b.minutes} دقيقة`],
      ['الدكتورة', esc(b.doctor)],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const editable = s === 'booked' || s === 'confirmed';
    $('qActions').innerHTML = editable ? `
      ${s === 'booked' ? '<button class="btn btn-coral" data-act="confirm">أكيد، جاية</button>' : '<span class="confirmed-note">✓ أكّدتي حضورك</span>'}
      <button class="btn btn-outline" data-act="reschedule">أريد أغيّر الموعد</button>
      <button class="btn btn-text" data-act="cancel">إلغاء الموعد</button>` : '';
    $('qActions').querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => onAction(btn.dataset.act, btn)));
    if (!editable) closePanel();
  }

  // ---- ownership check: last 4 digits of the phone, remembered on this device
  function withOwner(run) {
    const p4 = store.get(p4Key);
    if (p4) return run(p4);
    openPanel(`<h3>تأكيد الهوية</h3><p class="muted">حتى نتأكد إنه إنتي، اكتبي آخر 4 أرقام من موبايلك (${esc(booking.phone_hint)}).</p>
      <form class="verify" id="vForm"><input id="vInput" inputmode="numeric" maxlength="4" dir="ltr" placeholder="••••" autocomplete="off">
      <button class="btn btn-coral">تأكيد</button></form><p class="bk-error" id="vErr" hidden></p>`);
    $('vInput').focus();
    $('vForm').addEventListener('submit', e => {
      e.preventDefault();
      const v = $('vInput').value.replace(/\D/g, '');
      if (v.length !== 4) { $('vErr').textContent = 'اكتبي 4 أرقام'; $('vErr').hidden = false; return; }
      store.set(p4Key, v); closePanel(); run(v);
    });
  }

  async function post(action, extra = {}) {
    const p4 = store.get(p4Key);
    try {
      booking = await api(`/api/q/${code}/${action}`, { method: 'POST', body: { phone4: p4, ...extra } });
      render();
      return true;
    } catch (e) {
      if (e.status === 403) { store.del(p4Key); withOwner(() => post(action, extra)); setTimeout(() => { const el = $('vErr'); if (el) { el.textContent = e.message; el.hidden = false; } }); }
      else flash(e.message);
      return false;
    }
  }

  let cancelArmed = false;
  function onAction(act, btn) {
    if (act === 'confirm') return withOwner(() => post('confirm'));
    if (act === 'cancel') {
      if (!cancelArmed) { cancelArmed = true; btn.textContent = 'متأكدة؟ اضغطي مرة ثانية'; btn.classList.add('danger'); setTimeout(() => { cancelArmed = false; if (btn.isConnected) { btn.textContent = 'إلغاء الموعد'; btn.classList.remove('danger'); } }, 4000); return; }
      cancelArmed = false;
      return withOwner(() => post('cancel'));
    }
    if (act === 'reschedule') return withOwner(openReschedule);
  }

  async function openReschedule() {
    config ||= await api('/api/config');
    const st = { date: config.open_days.includes(booking.date) ? booking.date : config.open_days[0], time: '' };
    openPanel(`<h3>اختاري وقت جديد</h3><div class="days" id="rDays"></div><div class="slots" id="rSlots"></div>
      <p class="bk-error" id="rErr" hidden></p>
      <div class="q-actions"><button class="btn btn-coral" id="rSave">ثبّتي الوقت الجديد</button><button class="btn btn-text" id="rClose">رجوع</button></div>`);
    const drawDays = () => renderDays($('rDays'), config.open_days, st.date, d => { st.date = d; st.time = ''; drawDays(); loadSlots(); }, config.today);
    let slots = [];
    const drawSlots = () => renderSlots($('rSlots'), slots, st.time, t => { st.time = t; drawSlots(); });
    async function loadSlots() {
      $('rSlots').innerHTML = '<p class="hint">نشوف الأوقات الفارغة…</p>';
      ({ slots } = await api(`/api/slots?service=${booking.service_id}&date=${st.date}&exclude=${code}`));
      drawSlots();
    }
    drawDays(); loadSlots();
    $('rClose').addEventListener('click', closePanel);
    $('rSave').addEventListener('click', async () => {
      if (!st.time) { $('rErr').textContent = 'اختاري الوقت'; $('rErr').hidden = false; return; }
      if (await post('reschedule', { date: st.date, time: st.time })) { closePanel(); flash('تم تغيير موعدك ✓'); }
      else loadSlots();
    });
  }

  function openPanel(html) { const p = $('qPanel'); p.innerHTML = html; p.hidden = false; p.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  function closePanel() { const p = $('qPanel'); if (p) { p.hidden = true; p.innerHTML = ''; } }
  function flash(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
  }

  load();
  timer = setInterval(() => { if (!document.hidden && booking && !['cancelled', 'done', 'no_show'].includes(booking.status)) load(); }, 15000);
})();
