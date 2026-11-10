// Business details printed on customer-facing documents (rental agreement,
// invoices). Each can still be overridden with the window.DRIVENOW_BUSINESS_*
// values the public site's js/config.js reads (set in an inline <script>
// above this file).
const BUSINESS = {
  name: window.DRIVENOW_BUSINESS_NAME || 'QueenCity Auto-Rentals',
  legalName: window.DRIVENOW_BUSINESS_LEGAL_NAME || '',
  address: window.DRIVENOW_BUSINESS_ADDRESS || '3765 E Independence Blvd',
  city: window.DRIVENOW_BUSINESS_CITY || 'Charlotte, NC',
  phone: window.DRIVENOW_BUSINESS_PHONE_DISPLAY || '(704) 595-7070',
  email: window.DRIVENOW_BUSINESS_EMAIL || '',
};
