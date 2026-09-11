# Personal configuration sync

Pi Web can keep personal preferences consistent between independent Mac and Windows installations. Each installation continues to use its own files, credentials and sessions. The feature is off until a private GitHub repository is selected in **Settings → General → Configuration sync**.

## First connection

1. Install this version of Pi Web on both computers. Configuration sync does not deploy Pi Web source code or upgrade the Pi runtime.
2. Make sure the server's user can run `gh` and is signed in to GitHub (`gh auth login --hostname github.com`). The same private repository must be writable from both computers. No access token is entered into Pi Web or stored in the shared profile.
3. Create an empty private repository for the configuration. Enter its `owner/repo` name on the first computer, enable sync and save. Pi Web writes `pi-web-profile.json` on the repository's default branch.
4. Enter the same repository on the second computer and enable sync. An existing remote profile wins on the first connection. A local backup is written before applying changes.

While a Pi Web page is visible, changes are detected automatically and the remote is checked approximately every 30 seconds. Returning to the page or coming back online triggers a check. The **Sync now** button also checks immediately. A closed browser is not a background scheduler. Offline changes remain local until the next successful check.

## Shared fields

| Group | Included |
| --- | --- |
| Model defaults | Provider/model pair, default thinking level, per-model thinking defaults, enabled model scope |
| Built-in subagents | Global enabled/disabled switch |
| npm plugins | Exact installed/configured version, package autoload switch and package-relative extension filters; an empty extension list disables extensions |
| Browser preferences | Theme, language, completion sound, default tool preset, remembered thinking level, default thinking expansion, content width/font size, selection quoting |

Credentials and provider endpoint definitions, skills directories and files, sessions, scheduled jobs, local/git resources, shell paths, PowerShell choice, notification permissions and browser drafts are excluded. Global npm plugin configuration is shared; project-level plugins remain project-owned. Existing per-package skill/prompt/theme filters stay local. Newly synced npm plugins load only their extensions.

Only exact npm versions are written to the profile. Unpinned local packages are resolved to the version installed on the sending computer, including Pi's supported legacy global npm location. Receiving computers prepare package changes in a copy of their local npm directory, verify the complete set, then activate it with rollback on failure. A failed install or remote write leaves the live package directory intact. Sync and the plugin management API share one operation lock. Plugin activation waits while Pi Web reports active work. Existing session wrappers are not reloaded automatically: new sessions use the updated configuration, and an existing session can be reloaded explicitly.

## Conflicts and recovery

Sync uses the previous shared profile as a common base. Changes to independent fields merge automatically. The default provider/model pair, per-model defaults map, model scope and plugin list are atomic fields; browser preferences merge individually. When both computers change the same field differently, neither side is overwritten. The settings page lists the conflicts and provides **Keep local** and **Use remote**; each choice applies only to the conflicting fields, preserving unrelated edits.

GitHub's file SHA guards each write. If another computer updates the file during a sync, that write fails and the next attempt reads the new profile. Public repositories, unexpected profile fields, unpinned sources and non-relative plugin filters are rejected.

Local state lives in `<Pi agent directory>/pi-web-config-sync.json`, including the repository selection, browser preferences and merge base. On the managed Windows installation that directory is `D:\Pi\data`; on a standard Mac installation it is `~/.pi/agent`, unless `PI_CODING_AGENT_DIR` overrides it. The shared file contains only the allow-list defined in `lib/config-sync-profile.ts`.

The most recent pre-apply Pi settings and subagent settings are saved locally to `pi-web-config-sync-backup.json`. This backup is never uploaded. Disable sync before manually restoring it. Disabling sync preserves current settings, plugins and remote history.

## Verification

Run `node --experimental-strip-types --test lib/config-sync*.test.mjs app/api/config-sync/route.test.mjs components/ConfigSyncSettings.test.mjs`, `npm run lint`, and `node_modules/.bin/tsc --noEmit`.

The integration tests use two isolated agent directories and an optimistic-concurrency remote to cover first connection, bidirectional changes, conflicts, no-op sync, offline errors, plugin version checks, active-work deferral and concurrent local edits. The browser test `e2e/config-sync.mjs` uses a controlled sync endpoint, never the real configuration repository.
