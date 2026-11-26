# Public repository data boundary

Keep real student records, original institution documents, imports, exports, database files, backups, attachments and browser profiles outside every Git checkout. The application data root and user-selected private export folders are separate from the source repository. This public repository is not a business backup service.

Never commit credentials, source institution login information, private user paths or real student screenshots. Do not paste these into issues, PRs, comments or CI logs. A source file being ignored is not proof that it is safe: tracked files, forced additions and earlier commits remain visible.

## Before committing

Run `node scripts/check-sensitive-files.cjs --staged`. It reads index blobs, so changing the working file after staging cannot hide the staged contents. `--tracked` checks all index entries. `--history BASE..HEAD` checks each revision's tree and that revision's fixture manifest, including content later removed. None of these modes rewrites Git history or uploads files.

The guard rejects known database/backup/archive magic, private file types and directories, symlinks/submodules, unreviewed binary data, LFS pointers, oversized files, credential patterns, realistic contact/identity number shapes and personal Windows paths. Findings show only a rule, line, object/revision identity when relevant, and a hashed file ID. They never echo matched values or potentially identifying filenames. To locate a file ID locally, compute SHA256 of its repository-relative path and compare the first 16 hex characters. Do not publish a private path-to-ID lookup.

Pattern detection is a prevention layer, not proof of absence of all private data. It cannot recognize arbitrary personal names or secrets encrypted inside an opaque object. PR review remains necessary; never test a suspected credential against a service to see if it works.

## Synthetic fixture review

Only `test/fixtures/manifest.json` can declare reviewed JSON/image bytes. Each entry binds exact SHA256, synthetic purpose, construction provenance, explicit no-real-student declaration and review status. Labels such as DEMO or “synthetic” alone are insufficient. Credential and contact checks still apply to approved text fixtures.

New or changed manifest entries require review of the data's construction and, for images, visual inspection of every image and metadata. Never copy real student data and merely change the names. Changes to a hash or `reviewed: true` do not constitute independent review. Existing acceptance images declared in the manifest may live on other review branches; an absent optional image entry is not a reason to copy a binary into this PR.

Use deterministic invented identities and generated dates/scores. Do not use real phone numbers, institution accounts, source Word/Excel files, browser sessions or screenshots. Construct detector-shaped test inputs in memory so complete token-like examples are not stored in Git. Tests must not read the clipboard or business data.

## Privacy CI and incident handling

The separate Privacy guard workflow uses a read-only checkout with no persisted credentials, no npm install and no artifact upload. It scans tracked content and every PR revision. It does not change the established application verification or release workflows, and its success is not a release approval.

For an apparent leak, stop reproducing the value, record only category, relative/revision location and redacted evidence, and notify the owner. Revoke or rotate a real credential first. Removing the current file or making a repository private cannot retract copies already obtained. History rewriting, force-pushing, deleting remote resources and visibility changes require separate explicit approval. Existing author email exposure must be handled separately from this ordinary maintenance PR; future commits should use GitHub noreply.

## Business export constraints (Batch 2E)

Business exports are private local artifacts, never CI artifacts or repository fixtures. A full business export and a shareable synthetic example are different things. Confirm selected records, identity fields, source text/attachments and destination before writing; use a new repository-external directory and never silently overwrite backups or existing files.

Do not export browser sessions, application credentials or internal system accounts. Free text and imported institution material need explicit local review; pattern matching cannot guarantee their safety. Preserve identities, original values and necessary historical records according to the selected private scope, and state exclusions/failures without logging record contents. No automatic cloud upload, sharing or real-data-based tests. This maintenance PR implements no export feature, schema or backup format change.
