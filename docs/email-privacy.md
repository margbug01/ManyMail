# Email display privacy

Remote images are blocked by default in hosted-mail and external-IMAP message previews. HTML sanitization removes active content; the sandboxed message frame also uses a restrictive Content Security Policy. External stylesheets, fonts, frames, forms and CSS resource requests are not enabled by the image button.

A message with external images has a small button immediately above its body. Loading requires confirmation and uses the existing authenticated Flask image proxy. Consent applies only to that rendered message, is never persisted, and resets when the message is reopened. Clicking the button again blocks images; it cannot undo a request that already reached a sender.

A proxy hides the reader's network address from the image host, but a unique image URL can still identify an opened message. Explicitly following an external link can likewise reveal a click. This feature is not anonymity or protection for third-party mail clients, downloaded HTML, or forwarded copies opened elsewhere.

Raster data images remain available. IMAP mailparser resolves embedded CID images before display. Unknown/relative image sources and SVG data images are not auto-loaded. Attachments, SMTP storage, forwarding, mailbox persistence, IMAP authentication and page layout are unchanged. The only new UI is the per-message image control; there is no global privacy banner.

## Verification

```sh
python -m pytest mail-viewer/tests -q
npm --prefix mail-viewer/imap-mail-app ci --ignore-scripts
(cd mail-viewer/imap-mail-app && node --test)
```

For the browser regression, install Playwright in a temporary workspace directory and run the retained test script:

```sh
npm --prefix .alma/privacy-browser install playwright --ignore-scripts
PLAYWRIGHT_MODULE="$PWD/.alma/privacy-browser/node_modules/playwright" \
BROWSER_PATH="/path/to/chrome" node tools/test-email-privacy.cjs
```

Without `BROWSER_PATH`, Playwright uses its installed Chromium. The test serves synthetic mail locally, runs the actual two rendering functions, intercepts all tracker-domain requests, and counts local proxy requests. Expected for each renderer: zero automatic requests, zero requests after canceled consent, one proxy request after consent, no referrer header, and no new requests after reopening. It does not read real mail or contact a production service.

The viewer Dockerfile includes the shared privacy script. No server deployment or Git push is performed as part of this local implementation.
