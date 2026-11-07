// Bloom — booking widget on the homepage
(() => {
  const { api, renderDays, renderSlots, fmtTime, longDate, esc, store, confirmationText } = Bloom;
  const $ = id => document.getElementById(id);
  const form = $('booker'), done = $('bkDone');
  const sel = $('bkService'), daysEl = $('bkDays'), slotsEl = $('bkSlots'), err = $('bkError'), submit = $('bkSubmit');
  const state = { config: null, service: '', date: '', time: '' };
  const CATS = { laser: 'ليزر', care: 'عناية وتنظيف', medical: 'علاجي', rejuv: 'نضارة وشباب' };

  const showError = msg => { err.textContent = msg; err.hidden = !msg; };

  async function init() {
    try {
      state.config = await api('/api/config');
    } catch (e) {
      daysEl.innerHTML = '';
      slotsEl.innerHTML = '';
      showError(location.protocol === 'file:'
        ? 'الحجز يشتغل لما تفتحين الموقع من السيرفر: شغّلي python server.py وافتحي http://localhost:8080'
        : e.message);
      submit.disabled = true;
      return;
    }
    const groups = {};
    state.config.services.forEach(s => (groups[s.cat] ||= []).push(s));
    sel.innerHTML = '<option value="">اختاري العلاج…</option>' + Object.entries(groups).map(([cat, list]) =>
      `<optgroup label="${CATS[cat] || cat}">${list.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('');
    state.date = state.config.open_days[0];
    drawDays();
    if (state.service) pickService(state.service);
  }

  function drawDays() {
    renderDays(daysEl, state.config.open_days, state.date, d => { state.date = d; state.time = ''; drawDays(); loadSlots(); }, state.config.today);
  }

  function pickService(id) {
    state.service = id;
    if (!state.config) return;
    sel.value = id;
    const svc = state.config.services.find(s => s.id === id);
    $('bkDuration').textContent = svc ? `مدة الجلسة تقريباً ${svc.minutes} دقيقة` : '';
    state.time = '';
    loadSlots();
  }

  let slotReq = 0;
  async function loadSlots() {
    if (!state.service) { slotsEl.innerHTML = '<p class="hint">اختاري العلاج أولاً.</p>'; return; }
    const req = ++slotReq;
    slotsEl.innerHTML = '<p class="hint">نشوف الأوقات الفارغة…</p>';
    try {
      const { slots } = await api(`/api/slots?service=${encodeURIComponent(state.service)}&date=${state.date}`);
      if (req !== slotReq) return;
      if (state.time && !slots.includes(state.time)) state.time = '';
      renderSlots(slotsEl, slots, state.time, t => { state.time = t; loadSlotsCached(slots); showError(''); });
    } catch (e) {
      if (req === slotReq) slotsEl.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    }
  }
  const loadSlotsCached = slots => renderSlots(slotsEl, slots, state.time, t => { state.time = t; loadSlotsCached(slots); });

  sel.addEventListener('change', () => pickService(sel.value));

  // "احجز ←" links on treatment cards preselect the service
  document.querySelectorAll('[data-service]').forEach(a => a.addEventListener('click', () => {
    if (!done.hidden) reset();
    pickService(a.dataset.service);
  }));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('bkName').value.trim(), phone = $('bkPhone').value.trim();
    if (!state.service) return showError('اختاري العلاج.');
    if (!state.time) return showError('اختاري الوقت اللي يناسبك.');
    if (name.length < 2) return showError('اكتبي اسمك.');
    if (!phone) return showError('اكتبي رقم موبايلك حتى نرسلك التأكيد.');
    showError('');
    submit.disabled = true; submit.textContent = 'لحظة…';
    try {
      const b = await api('/api/bookings', { method: 'POST', body: { service: state.service, date: state.date, time: state.time, name, phone, notes: $('bkNotes').value } });
      store.set('bloom-p4-' + b.code, phone.replace(/\D/g, '').slice(-4));
      store.set('bloom-last', b.code);
      $('doneCode').textContent = b.code;
      $('doneMsg').innerHTML = esc(confirmationText(b, b.doctor, state.config.public_url)).replace(/\n/g, '<br>');
      $('doneTrack').href = '/q/' + b.code;
      form.hidden = true; done.hidden = false;
      done.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e2) {
      showError(e2.message);
      if (e2.status === 409) loadSlots();
    } finally {
      submit.disabled = false; submit.textContent = 'ثبّتي الموعد';
    }
  });

  function reset() {
    form.reset(); state.time = '';
    if (state.service) sel.value = state.service;
    done.hidden = true; form.hidden = false;
    loadSlots();
  }
  $('doneAgain').addEventListener('click', reset);

  init();
})();
