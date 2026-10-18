# Email display privacy

Remote images are blocked by default in hosted-mail and external-IMAP message previews. HTML sanitization removes active content; the sandboxed message frame also uses a restrictive Content Security Policy. External stylesheets, fonts, frames, forms and CSS resource requests are not enabled by the image button.

A message with external images has a small button immediately above its body. Loading requires confirmation and uses the web UI's authenticated image proxy. Consent applies only to that rendered message, is never persisted, and resets when the message is reopened. Clicking the button again blocks images; it cannot undo a request that already reached a sender.

A proxy hides the reader's network address from the image host, but a unique image URL can still identify an opened message. Explicitly following an external link can likewise reveal a click. This feature is not anonymity or protection for third-party mail clients, downloaded HTML, or forwarded copies opened elsewhere.

Raster data images remain available. IMAP mailparser resolves embedded CID images before display. Unknown/relative image sources and SVG data images are not auto-loaded. Attachments, SMTP storage, forwarding, mailbox persistence, IMAP authentication and page layout are unchanged. The only new UI is the per-message image control; there is no global privacy banner.

## Verification

```sh
go test -run 'TestSanitize|TestRender|TestImageProxy' ./...
(cd imap-bridge && npm ci --ignore-scripts && node --test)
tools/test-ui.sh      # includes the browser regression tools/test-email-privacy.cjs
```

`tools/test-ui.sh` installs `playwright-core` into a cache directory outside the repository;
set `BROWSER_PATH` if Chromium is not in Playwright's default location. The test serves synthetic mail locally, runs the actual two rendering functions, intercepts all tracker-domain requests, and counts local proxy requests. Expected for each renderer: zero automatic requests, zero requests after canceled consent, one proxy request after consent, no referrer header, and no new requests after reopening. It does not read real mail or contact a production service.

The shared privacy script is embedded into the `manymail` binary (`web/shared/email-privacy.js`, a copy of `imap-bridge/public/email-privacy.js`).
