// ── Nav ──
const hamburger = document.querySelector('.nav__hamburger');
const mobileMenu = document.querySelector('.nav__mobile');
if (hamburger && mobileMenu) {
  hamburger.addEventListener('click', () => mobileMenu.classList.toggle('open'));
}

// Mark active nav link
document.querySelectorAll('.nav__links a, .nav__mobile a').forEach(link => {
  if (link.href === window.location.href) link.classList.add('active');
});

// ── Slideshows ──
document.querySelectorAll('.slideshow').forEach(ss => {
  const slides = ss.querySelectorAll('.slide');
  const dots = ss.querySelectorAll('.slide-dot');
  let current = 0, timer;

  function goTo(n) {
    slides[current].classList.remove('active');
    dots[current]?.classList.remove('active');
    current = (n + slides.length) % slides.length;
    slides[current].classList.add('active');
    dots[current]?.classList.add('active');
  }

  function startAuto() { timer = setInterval(() => goTo(current + 1), 3800); }
  function stopAuto() { clearInterval(timer); }

  ss.querySelector('.slide-arrow--prev')?.addEventListener('click', () => { stopAuto(); goTo(current - 1); startAuto(); });
  ss.querySelector('.slide-arrow--next')?.addEventListener('click', () => { stopAuto(); goTo(current + 1); startAuto(); });
  dots.forEach((d, i) => d.addEventListener('click', () => { stopAuto(); goTo(i); startAuto(); }));

  if (slides.length > 0) { slides[0].classList.add('active'); dots[0]?.classList.add('active'); }
  if (slides.length > 1) startAuto();
});

// ── Earnings Calculator ──
const calcEl = document.getElementById('calculator');
if (calcEl) {
  const inputs = {
    days: document.getElementById('calc-days'),
    rate: document.getElementById('calc-rate'),
    gas: document.getElementById('calc-gas'),
    misc: document.getElementById('calc-misc'),
  };
  const labels = {
    days: document.getElementById('val-days'),
    rate: document.getElementById('val-rate'),
    gas: document.getElementById('val-gas'),
    misc: document.getElementById('val-misc'),
  };
  const results = {
    gross: document.getElementById('res-gross'),
    rental: document.getElementById('res-rental'),
    gas: document.getElementById('res-gas'),
    misc: document.getElementById('res-misc'),
    net: document.getElementById('res-net'),
    monthly: document.getElementById('res-monthly'),
  };

  function calculate() {
    const days = +inputs.days.value;
    const rate = +inputs.rate.value;
    const gasPerDay = +inputs.gas.value;
    const miscWeek = +inputs.misc.value;

    const weeks = days / 7;
    const rentalWeekly = +document.getElementById('calc-rental').value;

    const grossWeekly = days * rate;
    const rentalCost = rentalWeekly;
    const gasCost = gasPerDay * days;
    const netWeekly = grossWeekly - rentalCost - gasCost - miscWeek;
    const netMonthly = netWeekly * 4.3;

    labels.days.textContent = days + ' days';
    labels.rate.textContent = '$' + rate;
    labels.gas.textContent = '$' + gasPerDay + '/day';
    labels.misc.textContent = '$' + miscWeek;

    results.gross.textContent = '$' + grossWeekly.toFixed(0);
    results.rental.textContent = '- $' + rentalCost.toFixed(0);
    results.gas.textContent = '- $' + gasCost.toFixed(0);
    results.misc.textContent = '- $' + miscWeek.toFixed(0);
    results.net.textContent = '$' + Math.max(0, netWeekly).toFixed(0);
    results.monthly.textContent = '$' + Math.max(0, netMonthly).toFixed(0);
  }

  Object.values(inputs).forEach(el => el?.addEventListener('input', calculate));
  document.getElementById('calc-rental')?.addEventListener('change', calculate);
  calculate();
}

// ── FAQ Accordion ──
document.querySelectorAll('.faq-question').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});

// ── Application Form ──
const appForm = document.getElementById('application-form');
if (appForm) {
  appForm.addEventListener('submit', e => {
    e.preventDefault();
    appForm.style.display = 'none';
    document.getElementById('form-success').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ── Contact Form ──
const contactForm = document.getElementById('contact-form');
if (contactForm) {
  contactForm.addEventListener('submit', e => {
    e.preventDefault();
    contactForm.style.display = 'none';
    document.getElementById('contact-success').style.display = 'block';
  });
}

// ── Animate on scroll ──
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); } });
}, { threshold: 0.1 });

document.querySelectorAll('.fleet-card, .step, .resource-card, .faq-item').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(24px)';
  el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  observer.observe(el);
});
document.addEventListener('DOMContentLoaded', () => {
  // re-run so already-visible items show immediately
  document.querySelectorAll('.fleet-card, .step, .resource-card, .faq-item').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) el.classList.add('visible');
  });
});
document.head.insertAdjacentHTML('beforeend', `<style>.visible{opacity:1!important;transform:none!important;}</style>`);
