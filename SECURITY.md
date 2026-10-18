# Security Policy

ManyMail listens for SMTP on a public port and renders untrusted HTML in the webmail viewer. Both are worth attacking, and both are worth reporting bugs against.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/margbug01/ManyMail/security/advisories/new). The report stays private until a fix ships.

Please do not open a public issue for a security problem.

Include what you can:

- affected component — `manymail` (SMTP, API, web UI, rules) or `imap-bridge`
- the commit you tested
- steps to reproduce, with the request or the message that triggers it
- what an attacker gains

Expect a first reply within 7 days. ManyMail is maintained in spare time, so a fix usually takes longer than the acknowledgement.

## In scope

- remote code execution, authentication bypass, privilege escalation
- XSS in the webmail viewer, including bypasses of the HTML and CSS sanitizer in `sanitize.go`
- SMTP relay abuse — getting the server to deliver mail it should refuse
- SSRF through the image proxy or the IMAP bridge
- reading another mailbox's messages or attachments
- leaking `API_KEY`, `RESEND_API_KEY`, Resend keys saved in Settings, or mailbox credentials

## Out of scope

- a deployment that skipped [docs/production-hardening.md](docs/production-hardening.md)
- running with the placeholder `SECRET_KEY`, `ACCESS_PASSWORD`, or `UNIFIED_PASSWORD` from `.env.example`
- spam and deliverability caused by DNS records (SPF, DKIM, DMARC) under your control
- denial of service through raw traffic volume
- scanner output with no working proof of concept

## Supported versions

Fixes land on `master`. There are no long-lived release branches, so run a recent commit.

## Before you expose an instance

Read [docs/production-hardening.md](docs/production-hardening.md). Set every secret in `.env`, keep `AUTO_CREATE_ACCOUNTS=0` in production, and put the viewer behind TLS.
