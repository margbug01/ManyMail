# awesome-selfhosted submission checklist

Audited 2026-08-22 against the [PR template](https://github.com/awesome-selfhosted/awesome-selfhosted-data/blob/master/.github/PULL_REQUEST_TEMPLATE.md)
and [CONTRIBUTING.md](https://github.com/awesome-selfhosted/awesome-selfhosted-data/blob/master/CONTRIBUTING.md)
of `awesome-selfhosted/awesome-selfhosted-data`.

Entries are no longer README edits. A submission is one new file,
`software/manymail.yml`, in the `awesome-selfhosted-data` repository. The draft is in
[awesome-selfhosted-entry.yml](awesome-selfhosted-entry.yml).

## Release requirement — resolved, with one residual risk

The original blocker was that ManyMail had no tags at all. The maintainers keep a canned
reply for exactly that case:

> there are no tagged releases for this project. Our guidelines require that *Any software
> project you are adding was first released more than 4 months ago.* We encourage you to
> create a release now and/or a simple changelog […]

Fixed on 2026-08-22: [v1.0.0](https://github.com/margbug01/ManyMail/releases/tag/v1.0.0) is
tagged and published, with [CHANGELOG.md](../CHANGELOG.md). Their tooling can now fill the
`current_release` block the way it does for the comparable accepted entry
[`maddy-mail-server.yml`](https://github.com/awesome-selfhosted/awesome-selfhosted-data/blob/master/software/maddy-mail-server.yml).

**Residual risk.** The checkbox reads "first released more than 4 months ago", and the
guidelines never define whether that clock starts at repository creation or at the first
tag. Two readings:

- repository age — public since 2026-04-05, 138 days, passes
- first tag age — v1.0.0 is dated today, fails until roughly 2026-12-22

The canned reply tells submitters to "create a release now", which only makes sense under
the first reading, so the submission should stand. A maintainer may still disagree and ask
you to wait. Nothing more can be done about it from this side.

## Passing

| Requirement | Status |
|:---|:---|
| Self-hostable server software, not a library or SDK | Yes — SMTP and HTTP daemons |
| Not merely a Dockerization of an existing project | Yes — original Go implementation |
| Not dependent on a specific cloud provider | Yes — outbound Resend is optional |
| Free and open-source license | MIT, already in `licenses.yml` |
| Working installation instructions | README quick start plus `docker compose` |
| Actively maintained | 36 commits since April, most recent this month |
| Tagged release exists | v1.0.0, 2026-08-22 |
| Changelog | [CHANGELOG.md](../CHANGELOG.md), Keep a Changelog format |
| Not already listed, and not on awesome-sysadmin | Checked — no `manymail` entry |
| Tag exists in `tags/` | `Communication - Email - Complete Solutions` |
| Platforms exist in `platforms/` | `Go`, `Nodejs`, `Docker` |
| Description under 250 characters, sentence case | 143 characters |
| Description avoids "open-source", "free", "self-hosted" | Yes |
| kebab-case filename | `manymail.yml` |

## Judgment calls to make before submitting

- **`demo_url`** — optional, and only for an interactive demo. Leave it out unless a public
  instance is running, and note that the field would expose that instance.
- **"alternative to" suffix** — the guidelines ask for `(alternative to $PRODUCT)` when a
  project presents itself that way. The README positions ManyMail as a *different job* from
  Mailcow rather than a replacement, so the draft omits it. Add
  `(alternative to Mailcow, docker-mailserver)` if you would rather claim the comparison.
- **Category** — `Communication - Email - Complete Solutions` fits best. In single-page mode
  only the first tag renders, so do not put `Webmail Clients` first.

## Process notes

- One item per pull request.
- Remove every comment and unused optional field from the YAML before submitting.
- Merges land roughly a week after approval.
- Their contributing guide bans LLM-generated submissions that ignore the guidelines. Read
  the entry yourself before opening the PR.
