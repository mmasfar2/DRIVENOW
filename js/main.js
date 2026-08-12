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
  // Pre-fill the selected vehicle from the fleet page query string
  const vParams = new URLSearchParams(window.location.search);
  const vId = vParams.get('vehicle_id');
  if (vId) {
    document.getElementById('vehicle-id').value = vId;
    const make = vParams.get('make') || '';
    const model = vParams.get('model') || '';
    const year = vParams.get('year') || '';
    const rate = vParams.get('rate') || '';
    document.getElementById('selected-vehicle-name').textContent = `${year} ${make} ${model}`.trim();
    document.getElementById('selected-vehicle-rate').innerHTML = rate ? `$${rate} / week &nbsp;·&nbsp; <a href="fleet.html">Change vehicle</a>` : `<a href="fleet.html">Change vehicle</a>`;
  }

  // Upload boxes: click opens the hidden file input, shows the chosen filename
  document.querySelectorAll('.upload-box').forEach(box => {
    const input = document.getElementById(box.dataset.target);
    if (!input) return;
    box.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const nameEl = box.querySelector('.upload-box__filename');
      if (input.files[0]) {
        nameEl.textContent = `Selected: ${input.files[0].name}`;
        box.classList.add('has-file');
      } else {
        nameEl.textContent = '';
        box.classList.remove('has-file');
      }
    });
  });

  // Insurance Yes/No toggle
  const insuranceGroup = document.getElementById('insurance-upload-group');
  document.querySelectorAll('input[name="has_own_insurance"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const showUpload = document.querySelector('input[name="has_own_insurance"]:checked')?.value === 'yes';
      insuranceGroup.style.display = showUpload ? '' : 'none';
      document.getElementById('insurance-upload').required = showUpload;
    });
  });

  appForm.addEventListener('submit', async e => {
    e.preventDefault();
    const submitBtn = appForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Submitting…';
    submitBtn.disabled = true;

    const phoneValue = document.getElementById('phone').value;
    const licenseNumberValue = document.getElementById('license-number')?.value || '';
    const zipValue = document.getElementById('zip')?.value || '';
    if (phoneValue.replace(/\D/g, '').length !== 10) {
      alert('Please enter a valid 10-digit phone number.');
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
      return;
    }
    if (licenseNumberValue.replace(/[^0-9A-Za-z]/g, '').length < 4) {
      alert('Please double check your license number — it looks too short.');
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
      return;
    }
    if (zipValue.replace(/\D/g, '').length !== 5) {
      alert('Please enter a valid 5-digit ZIP code.');
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
      return;
    }

    const formData = new FormData();
    formData.append('first_name', document.getElementById('first-name').value);
    formData.append('last_name', document.getElementById('last-name').value);
    formData.append('phone', phoneValue);
    formData.append('email', document.getElementById('email').value);
    formData.append('dob', document.getElementById('dob')?.value || '');
    formData.append('address', document.getElementById('address').value);
    formData.append('city', document.getElementById('city')?.value || '');
    formData.append('state', document.getElementById('state')?.value || '');
    formData.append('zip_code', zipValue);
    formData.append('vehicle_id', document.getElementById('vehicle-id')?.value || '');
    formData.append('vehicle_tier', document.getElementById('vehicle-tier')?.value || '');
    formData.append('rental_duration', document.getElementById('rental-duration')?.value || '');
    formData.append('notes', document.getElementById('notes')?.value || '');
    formData.append('has_own_insurance', document.querySelector('input[name="has_own_insurance"]:checked')?.value || '');
    formData.append('license_number', licenseNumberValue);
    formData.append('consent_background', document.getElementById('agree-terms').checked ? 'true' : 'false');
    const licenseFile = document.getElementById('license-upload')?.files[0];
    const insuranceFile = document.getElementById('insurance-upload')?.files[0];
    if (licenseFile) formData.append('license', licenseFile);
    if (insuranceFile) formData.append('insurance', insuranceFile);

    try {
      const res = await fetch(`${API_BASE_URL}/api/applications`, { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Submission failed');
      }
      appForm.style.display = 'none';
      document.getElementById('form-success').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      alert('There was a problem submitting your application: ' + err.message);
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
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
