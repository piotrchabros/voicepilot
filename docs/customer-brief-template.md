# Customer brief template

Template for `customers/<name>.md`. This directory is gitignored (see
`.gitignore`) because customer briefs are personal data — see
`docs/compliance.md` § "Cloud analysis LLM (Phase 6) gate" for the
compliance status/gate that applies to sending this content to the cloud
analysis LLM.

Copy this file to `customers/<name>.md` and fill in only what's needed to
run the call well. This is a single-operator tool — keep it proportionate;
don't build a CRM record.

```markdown
# <Customer / company name>

## Business-relevant facts
- Role / decision-making authority:
- Company size / segment:
- Product(s) of interest:
- Budget / timeline signals (if known):
- Prior conversation history (dates, key points):
- Known objections or concerns raised so far:

## Notes for next call
- (Business-relevant only — see data-minimization note below)
```

## Data-minimization note

**Business-relevant facts only.** Do not record health information, family
details, or any other Art. 9 GDPR special-category data (race/ethnicity,
religious/political beliefs, health, sexual orientation, trade-union
membership, biometric/genetic data). This is not just a privacy nicety —
this content flows into **every** LLM call once the Phase 6 cloud analysis
gate opens, so anything written here becomes part of the prompt sent to a
third-party processor on every future call with this customer.

If you wouldn't want a piece of information handed unprompted to a cloud AI
vendor, don't put it in the brief.

## Storage rule

Keep `customers/` as a **local directory only**. Do not put it inside a
cloud-synced folder (iCloud Drive, Dropbox, Google Drive, OneDrive, etc.) —
doing so silently adds an undocumented processor (the sync provider) that
has not been reviewed or covered by any DPA in `docs/compliance.md`.

## Deletion / data-subject access

- **Deletion**: delete the customer's `customers/<name>.md` file when the
  relationship ends, or immediately on request.
- **Data-subject access request**: the file *is* the record — open
  `customers/<name>.md` to see everything held about that person.
