# Fork attribution and scope

This repository is an **unofficial experimental fork** of [`dawhubapp/flpdiff`](https://github.com/dawhubapp/flpdiff).

## Upstream credit

The original `flpdiff` project was created by **Roman Pronskiy** and is distributed under the MIT License.

The upstream project provides the core of this repository, including the FL
Studio `.flp` parser, semantic diff engine, Git integration, project inspection
commands, mutation/reorganization functionality, test corpus and test
infrastructure, CLI foundation, documentation, and surrounding architecture.

The original copyright and MIT license are preserved in [`LICENSE`](LICENSE).
The Git history of the upstream repository should also be preserved by creating
this repository through GitHub's **Fork** button rather than by publishing a
fresh repository with copied files.

Upstream project: https://github.com/dawhubapp/flpdiff

Original author: Roman Pronskiy

## Experimental additions in this fork

This fork adds a project preflight and storage-analysis layer intended to help
with large FL Studio projects whose `.flp` files reference substantial external
audio libraries.

The fork-specific additions include:

- `flpdiff preflight <file.flp>` for inventorying external sample and plugin dependencies.
- Resolution of project-relative audio paths.
- Repeatable `--search-path DIR` roots for relative samples stored outside the project directory.
- Optional mapping of FL Studio `%TOKEN%` paths with repeatable `--token NAME=DIR` arguments.
- Detection of missing or unresolved audio dependencies.
- Portability warnings for machine-specific absolute paths and references outside the project directory.
- `--format json` for machine-readable preflight reports.
- `--strict` for CI-style failure on portability warnings.
- Optional `--hash` mode that streams referenced files through SHA-256 without loading large WAV files into memory.
- Detection of byte-identical referenced audio files and calculation of
  redundant bytes that could potentially be saved by content-addressed storage.
- Resolved-path alias coalescing so the same physical pathname referenced in
  multiple ways is not falsely reported as duplicate storage.
- Public TypeScript exports for the preflight API.
- Unit/CLI tests and documentation for the new behavior.
- A cross-platform Git verification regression test that uses the active Bun executable instead of the POSIX-only `/bin/echo` path, so the suite also runs cleanly on native Windows.

Fork-specific CLI errors point to this fork's issue tracker rather than asking
the upstream maintainer to support experimental fork code.
The package metadata also points repository/bug links at the fork and marks the
package `private` to prevent accidentally publishing an experimental build under
the upstream npm package name. The original author field remains intact.

The preflight is intentionally scoped to dependencies exposed by the current
FLP parser. It does not inspect plugin-private sample libraries or prove that a
third-party plugin binary is installed.

The implementation is intentionally experimental and should be validated
against real FL Studio projects before being treated as production backup
software. See [`FLPDIFF_TESTING.md`](FLPDIFF_TESTING.md).

## Development disclosure

The experimental fork additions were produced with substantial AI assistance
and are being validated through explicit control/treatment tests on real
projects. They should not be interpreted as upstream-authored code unless and
until any portion is independently reviewed and merged upstream.

## Relationship to upstream

This fork does not claim authorship of upstream functionality and does not
imply endorsement by Roman Pronskiy, dawhub, or the upstream maintainers.

If the fork becomes useful enough to propose upstream, follow the upstream
[`CONTRIBUTING.md`](CONTRIBUTING.md), including opening an issue before
submitting a non-trivial pull request.
