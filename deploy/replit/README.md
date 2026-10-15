# Flow on Replit, from a pinned release

This folder is a template. Copy its contents into the root of your own
private deploy repository, pin a release with
`node verify-release.mjs pin <version>`, commit `flow.lock`, and import the
repository into Replit.

The build installs exactly the pinned `@arcforgelabs/flow` release and
refuses it unless its integrity, registry signatures and provenance check
out. The full guide is
[docs/SELF_HOSTING.md](https://github.com/arcforgelabs/flow/blob/main/docs/SELF_HOSTING.md)
in the Flow repository.
