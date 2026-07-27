// Backend API base URL. Defaults to the deployed Render service;
// override window.DRIVENOW_API_URL for local testing against localhost.
const API_BASE_URL = window.DRIVENOW_API_URL || 'https://drivenow-vgcc.onrender.com';

// Public-site business identity — kept out of the marketing pages themselves
// so this codebase can be handed off/resold without carrying any specific
// operator's name, phone, email, or city. Set window.DRIVENOW_BUSINESS_* in
// an inline <script> before this file loads (see index.html) to brand a real
// deployment; every page falls back to placeholder text otherwise.
const BUSINESS_NAME = window.DRIVENOW_BUSINESS_NAME || 'DriveNow';
const BUSINESS_LEGAL_NAME = window.DRIVENOW_BUSINESS_LEGAL_NAME || 'Your Company LLC';
const BUSINESS_CITY = window.DRIVENOW_BUSINESS_CITY || 'Your City, ST';
const BUSINESS_PHONE_DISPLAY = window.DRIVENOW_BUSINESS_PHONE_DISPLAY || '(555) 555-5555';
const BUSINESS_PHONE_TEL = window.DRIVENOW_BUSINESS_PHONE_TEL || '5555555555';
const BUSINESS_EMAIL = window.DRIVENOW_BUSINESS_EMAIL || 'info@example.com';

// Fills in every [data-biz] element/link on the page from the constants
// above. Call after the DOM is parsed (each page does this at the bottom of
// its own inline script, right after any other page-specific setup).
function applyBusinessInfo() {
  document.querySelectorAll('[data-biz="city"]').forEach(el => { el.textContent = BUSINESS_CITY; });
  document.querySelectorAll('[data-biz="phone"]').forEach(el => { el.textContent = BUSINESS_PHONE_DISPLAY; });
  document.querySelectorAll('[data-biz="email"]').forEach(el => { el.textContent = BUSINESS_EMAIL; });
  document.querySelectorAll('[data-biz="legal-name"]').forEach(el => { el.textContent = BUSINESS_LEGAL_NAME; });
  document.querySelectorAll('[data-biz-href="tel"]').forEach(el => { el.href = `tel:${BUSINESS_PHONE_TEL}`; });
  document.querySelectorAll('[data-biz-href="mailto"]').forEach(el => { el.href = `mailto:${BUSINESS_EMAIL}`; });
}
document.addEventListener('DOMContentLoaded', applyBusinessInfo);
