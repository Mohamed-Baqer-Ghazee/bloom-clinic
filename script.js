// Bloom Skin Clinic — site interactions
(() => {
  // Mobile menu
  const toggle = document.getElementById('menuToggle');
  const links = document.getElementById('navLinks');
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }));

  // Treatment filters
  const chips = document.querySelectorAll('.chip');
  const cards = document.querySelectorAll('#treatmentCards .card');
  chips.forEach(chip => chip.addEventListener('click', () => {
    chips.forEach(c => { c.classList.remove('active'); c.setAttribute('aria-selected', 'false'); });
    chip.classList.add('active'); chip.setAttribute('aria-selected', 'true');
    const f = chip.dataset.filter;
    cards.forEach(card => {
      const show = f === 'all' || card.dataset.cat.split(' ').includes(f);
      card.classList.toggle('hide', !show);
    });
  }));

  // Scroll reveal
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // Active nav link on scroll
  const navMap = new Map([...links.querySelectorAll('a')].map(a => [a.getAttribute('href').slice(1), a]));
  const so = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting && navMap.has(e.target.id)) {
        navMap.forEach(a => a.classList.remove('active'));
        navMap.get(e.target.id).classList.add('active');
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  navMap.forEach((_, id) => { const s = document.getElementById(id); if (s) so.observe(s); });

  document.getElementById('year').textContent = new Date().getFullYear();
})();
