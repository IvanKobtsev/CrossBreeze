# CrossBreeze

XCSS language support for WebStorm 2026.2+: diagnostics, go-to-definition, find
references, hover, lexical highlighting, semantic highlighting, and source formatting.

## Download and install

1. Open [GitHub Actions](https://github.com/IvanKobtsev/CrossBreeze/actions/workflows/ci.yml)
   and select a successful CI run. You must be signed into GitHub to download artifacts.
2. Download the artifact for your WebStorm installation's OS and CPU architecture.
   For example, choose **crossbreeze-windows-x86_64** for 64-bit Intel or AMD
   Windows, or **crossbreeze-mac-arm64** for an Apple Silicon installation.
3. Extract GitHub's artifact archive. Keep the inner platform-specific plugin ZIP intact.
4. In WebStorm, open **Settings → Plugins → gear → Install Plugin from Disk**,
   select that inner ZIP, and restart if prompted.
5. Configure a **local Node.js runtime** under **Languages & Frameworks → JavaScript Runtime**.
   Use Node 20.19.x or 22.12 and newer supported majors. Node and WebStorm must use
   the same CPU architecture.

Each plugin ZIP includes its server and the XCSS native binaries for its target.
Linux ZIPs support both glibc and musl. The plugin works offline with the configured
Node runtime. CI builds all six ZIPs on pushes, pull requests, and manual runs.
Artifacts expire after 30 days.

## Project behavior

CrossBreeze indexes XCSS in project content roots and follows explicit XCSS imports.
The stylesheet scan skips `.git`, `.idea`, `node_modules`, `dist`, `target`, `build`, `coverage`,
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

Basic editing also works without the server: the IDE's line and block comment
actions use CSS `/* ... */` comments, braces/parentheses/brackets and quotes are
paired automatically, and Enter preserves indentation and adds a configured
indent level inside opening delimiters. Enter between a matching pair places
the closing delimiter on its own line. Pair insertion follows the IDE's Smart
Keys settings; indentation uses the file's code-style tab/space settings.
When only tabs or spaces precede the caret, Backspace removes that indentation
and the preceding newline in one press, preserving any text after the caret.
On the first line, it clears the indentation to the start of the file.

Use **Code → Reformat Code** for whole-file XCSS formatting. The formatter runs
in the native Rust engine through the language server and includes XCSS variables,
constants, injections, utilities, calls, and ordinary CSS. It uses the file's IDE
indentation settings, right margin, and line separator. Configure defaults under
**Editor → Code Style → XCSS**. Node and a running language server are required.

CSS reference fixtures follow Prettier 3.6.2; exhaustive output compatibility is
not guaranteed. Syntax errors leave the document unchanged; unresolved imports
and semantic warnings do not block formatting. `@raw` bodies, unknown at-rules,
and nodes following `/* prettier-ignore */` stay verbatim. Formatting preserves
comments and declaration/import order. Selection and on-type formatting are not
provided.

The **Selectors** color group provides separate styles for classes, IDs, tags,
attribute names, pseudo-classes, pseudo-elements, universal selectors, nesting,
combinators, and namespace prefixes. Full selector classification uses the XCSS
language-service selector API. Specificity is
calculated by XCSS's selector API; editor specificity hints and warnings are not
enabled in this release.

Ctrl/Cmd-click and **Go to Declaration** follow `styles.button`
to its selector, `Variants<"Button">` to the group name, and a typed value such
as `variant="primary"` to its member in the `@variants` list. **Show Usages**
works from those references and their stylesheet declarations. Variant members
have separate usages for each group, even when they use the same class.

Completion uses the same module and group information. It suggests styles-map
keys, group names, contextual variant values, and class names inside
`@variants` and `composes`. TypeScript features use the file's project
configuration, and usages include matching files that are closed in the editor.

### Inline XCSS diagnostics

WebStorm underlines XCSS analyzer errors in open stylesheets and in TypeScript
files covered by a project configuration. Hover over a highlight to see its
stable `XC-*` code and explanation. TypeScript diagnostics cover unknown
classes and variant groups, invalid variant values, and unresolved XCSS
imports. Unsaved stylesheet and TypeScript edits refresh the highlights.

### TypeScript declaration setup

When an XCSS file or a TypeScript file importing XCSS is opened, CrossBreeze
shows an editor banner if its TypeScript project is missing XCSS declarations.
Choose **Add declarations** to create and open `xcss-env.d.ts` with a reference
to `@cross-css/vite/client`. The file is placed in the configured source
root, otherwise `src` when present, otherwise beside the TS configuration.
The Vite plugin's client declaration must already be installed in the project.

Existing client references, ambient `*.xcss` declarations, and the tsconfig
`types` option suppress the banner, including inherited settings. Existing files
are preserved; when the default name is occupied, CrossBreeze uses
`crossbreeze-xcss-env.d.ts`. If an explicit file list or exclusion prevents TS
from including the new file, a follow-up banner opens the TS configuration for
you to include it. CrossBreeze does not change your tsconfig automatically.
**Don't show again** remembers dismissal for that TS project. Banners refresh
when declarations or TS configuration change. No project files are created
until you choose the action.

## CSS validation

CrossBreeze checks ordinary CSS declaration names and values as you type, including
inside nested rules, keyframes, and injection definitions. For example, `dispay:
flex` reports an unknown property, `display: fex` reports an invalid value, and a
`time` variable used for `width` reports a type mismatch. These are warnings and
appear alongside native XCSS diagnostics.

**Check CSS property names** and **Check CSS values and types** can be switched
independently in the project's CrossBreeze settings. Both are enabled by default.
Changing them restarts the language server.

Validation uses CSSTree and the XCSS parser/resolver without compiling CSS. Typed
references use internal representative values (for example, `1s` for `time` and
`1` for `number`); warnings always point to the original source. This checks broad
compatibility, without refining types for signs, ranges, or integer-only positions.
A passing representative does not guarantee that every value of that type is valid.
Literal CSS values receive normal grammar validation.

Unknown or unresolved references, native `var()` values, incomplete syntax, and
unsupported XCSS transformations skip value checks while still allowing property
name checks. Custom properties accept unrestricted values. XCSS directives and
at-rule descriptors are excluded. At-rule validation, completion, and quick fixes
are not included. Newly introduced CSS may require a CSSTree data update.

## CSS value highlighting and colors

CSS functions, value keywords, and color literals have separate styles under
**Editor → Color Scheme → XCSS → CSS values**. Keywords follow CSS property
grammar, so font names and animation names retain their own meaning.

Literal named colors, hex, RGB/RGBA, and HSL/HSLA show WebStorm color swatches,
including in gradients, XCSS initializers, and parameter defaults. Click a swatch
to edit that literal with the native picker. Edits preserve hex/RGB/HSL families;
named colors become hex. References and computed colors do not get editable
swatches. Modern color spaces are not included yet.

Ctrl-hover underlines resolved symbols; Ctrl+click and Go to Declaration navigate
to their declarations.

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

The six installable ZIPs in `build/distributions` have OS and architecture suffixes.
Use `./gradlew buildPluginVariants` to build them without running verification.
`./gradlew runIde` opens a WebStorm
sandbox. Open a multi-file XCSS project, check diagnostics, Ctrl/Cmd-click an
injection or variable, find references, inspect hover, and edit an unsaved document
to verify live highlighting and diagnostics. Configure Node inside the sandbox.

CrossBreeze pins **@cross-css/native 0.9.0 from npm**, including package-lock
integrity. Packaging fetches the locked tarballs for each target, verifies SHA-512
integrity, includes licenses, and records per-file hashes. The npm bundle smoke
test loads the target matching the current Node runtime.

The CI packaging and artifact layout follows LocaleBreeze's editor workflow,
adapted to consume published XCSS packages rather than building engine binaries.
