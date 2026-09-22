# Release privacy review

Scope: current source tree, existing and newly added Markdown documentation, checked-in images,
release payloads and Docker build-context exclusions for 0.0.9.

## Findings and remediation

The historical master plan repeated a personal workstation path, a contact email and a private
preview hostname while describing an earlier cleanup. The current document now uses a workdir
placeholder and a reserved example hostname, and omits the contact address. Documentation must not
repeat the values it says were removed.

`.env.*` variants and `.playwright-cli/` session files are now excluded from both Git and Docker
context. `.env.example` remains available in Git as a template. Existing rules continue excluding
application data, stack directories, certificates, session state, updater snapshots, local review
artifacts, documentation and tests from the runtime image where appropriate.

A documentation regression check rejects personal home paths and non-example email addresses.
Public repository/registry coordinates, upstream attribution and license notices are functional
project metadata and remain unchanged.

## Evidence

- Gitleaks 8.30.1, downloaded from its official release and checksum-verified: no findings in the
  candidate source tree (approximately 4.42 MB at the initial scan).
- Reachable Git-history scan: 490 commits, one finding in a removed TOTP test. Inspection confirms
  the publicly specified RFC 6238 test vector, not an operational credential.
- Source/document scans also checked email domains, private IP examples, credential-bearing URLs,
  private-key/token patterns, phone-number patterns and personal workstation paths. Remaining
  addresses and credential-like values belong to reserved/example domains or explicit test fixtures.
- Checked-in PNG/ICO assets were inspected visually and for metadata. They contain the product icon
  or deterministic visual fixtures, not a live installation. No identifying text metadata was found.
- Release payloads are an explicit allow-list: descriptor, signatures, installer, vendor Compose and
  two native updater binaries. The build runs from the tagged checkout; local ignored files are not
  available to the release runner.

This review does not rewrite Git history or author attribution. Older commits and already published
source archives can retain earlier document contents and commit contact metadata. Removing those
historical copies would require a separate coordinated history/release cleanup; the 0.0.9 source
revision and its release files contain the sanitized documentation.

A secret scanner and visual review reduce the risk of accidental disclosure; they do not constitute
proof that every arbitrary string is anonymous. Local databases, credential stores and user stack
contents were not copied into the review or release artifacts.
