# OMD adaptation: 0.9.8-omd.1

This release distributes the OMD compatibility adaptation as a prebuilt GitHub TGZ from `gulagala001/dsh-plugin-subscriptions`. It does not publish the upstream `dsh-plugin-subscriptions` npm package. The package name, DSH bundle identity, upstream repository attribution and V1ki's MIT copyright remain intact.

The adaptation accepts DSH `0.2.0-rc.2` and `0.2.1-alpha.1` with their corresponding Cordis/Schemastery peers, preserves per-session Fast preferences, rejects stale browser reads and handles failed or corrupt preference saves without overwriting the preserved file.

The release workflow uses a frozen lockfile, builds, runs 9 offline store/RPC/command tests and 9 React/Chromium race/failure tests, and verifies the packed identity, license, runtime entries, bundle identifier and SHA256. The separate upstream npm OIDC workflow runs only in `V1ki/dsh-plugin-subscriptions`.

Before this release pipeline change, candidate source `2266140c0551863db23cb3592466e78112d90621` passed actual macOS stock DSH `0.2.0-rc.2` and `0.2.1-alpha.1` installation from TGZ, native SDK/client/settings/Fast-slot loading, RPC preference persistence and process restart, enable/disable and uninstall. These release-pipeline changes do not alter that runtime implementation. Empty accounts correctly hide native Fast. Native clickable Fast with a real account, actual provider priority effects, paid requests and Windows/Linux native desktop behavior remain unverified. No real accounts were used in the tests.

Download the TGZ, `SHA256SUMS` and matching `.metadata.json` from this release. Verify the TGZ before installing:

```sh
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add ./dsh-plugin-subscriptions-0.9.8-omd.1.tgz
```

Metadata records the exact source commit/tree, distribution repository and archive SHA256. This prerelease is a fork adaptation, not an upstream npm release. Existing historical peer declarations are preserved; only the two native hosts above have lifecycle evidence for this adaptation.

Maintainer entry point: merge a passing PR, tag the merged source as `v0.9.8-omd.1`, then push that tag explicitly to the owned fork. The `OMD GitHub artifact release` workflow checks the tagged source and publishes the assets. For local inspection, run the build and targeted tests, then `node scripts/pack-omd-release.mjs .release`; this command packs and verifies without publishing. Published release assets must not be replaced.
