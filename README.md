# CrossBreeze

XCSS language support for WebStorm 2026.2+: diagnostics, go-to-definition, find
references, hover, lexical highlighting, and semantic highlighting.

## Download and install

1. Open [GitHub Actions](https://github.com/IvanKobtsev/CrossBreeze/actions/workflows/ci.yml)
   and select a successful CI run. You must be signed into GitHub to download artifacts.
2. Download **crossbreeze-webstorm-plugin** from the run's Artifacts section.
3. Extract GitHub's artifact archive. Keep the inner `crossbreeze-0.1.0.zip` intact.
4. In WebStorm, open **Settings → Plugins → gear → Install Plugin from Disk**,
   select that inner ZIP, and restart if prompted.
5. Configure a **local Node.js runtime** under **Languages & Frameworks → JavaScript Runtime**.
   Supported versions match XCSS: Node 20.19.x or 22.12 and newer supported majors.

The plugin includes its server and all eight XCSS native platforms. It does not
download software or require an XCSS project dependency at runtime. CI builds an
installable ZIP on pushes, pull requests, and manual runs; artifacts expire after
30 days. Marketplace publication is not configured.

## Project behavior

CrossBreeze indexes XCSS in project content roots and follows explicit XCSS imports.
It ignores `.git`, `.idea`, `node_modules`, `dist`, `target`, `build`, `coverage`,
symlinked directory trees, and IDE excluded roots. Open unsaved documents override
disk contents. Files outside project roots are analyzed in isolation.

Relative imports and static `tsconfig.json` / `jsconfig.json` path aliases are
supported, including inherited JSON configuration. CrossBreeze does not execute
Vite or other JavaScript configuration. Project settings provide alias overrides:

```json
{ "@styles/*": ["src/styles/*"] }
```

Overrides take precedence, with paths relative to the containing project content
root. Configuration changes restart the server. The status-bar item shows server
state; click it or choose **Tools → Restart CrossBreeze Language Server** to restart.
Semantic colors can be customized under **Editor → Color Scheme → XCSS**. Lexical
highlighting remains available when Node or the server is unavailable.

Navigation currently covers XCSS files. Completion, rename, lint rules, fixes,
JS/TS `styles.button` navigation, remote Node runtimes, and CSS generation in the
editor are outside this first release.

## Development

Install JDK 25 and a supported Node.js runtime, then run:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run bundle
npm run verify:bundle
./gradlew test verifyPlugin verifyPluginArchive
```

The installable ZIP is in `build/distributions`. `./gradlew runIde` opens a WebStorm
sandbox. Open a multi-file XCSS project, check diagnostics, Ctrl/Cmd-click an
injection or variable, find references, inspect hover, and edit an unsaved document
to verify live highlighting and diagnostics. Configure Node inside the sandbox.

CrossBreeze pins **@cross-css/native 0.3.0 from npm**, including package-lock
integrity. Packaging fetches all eight locked native tarballs, verifies SHA-512
integrity, includes licenses, and records per-file hashes. There are no sibling
XCSS checkout, Git dependency, local tarball, or development-binary fallbacks.

The CI packaging and artifact layout follows LocaleBreeze's editor workflow,
adapted to consume published XCSS packages rather than building engine binaries.
