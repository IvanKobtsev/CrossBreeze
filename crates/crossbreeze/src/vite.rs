//! Source edits are derived from TypeScript syntax nodes, never text matches in comments.
use std::collections::BTreeMap;
use tsrs_ast::{Kind, Node, SourceFileParseOptions};
use tsrs_core::{P, ScriptKind};

fn start(source: &str, node: P<Node>) -> usize {
    tsrs_scanner::skip_trivia(source, node.pos().source_offset().unwrap()) as usize
}
fn end(node: P<Node>) -> usize {
    node.end().source_offset().unwrap() as usize
}

fn react_options(
    source: &str,
    plugins: Option<P<Node>>,
    imports: &BTreeMap<String, String>,
) -> Result<String, String> {
    let plugins = plugins.ok_or("Configure a supported React JSX transform manually.")?;
    if plugins.kind() != Kind::ArrayLiteralExpression {
        return Err("Computed React plugin list requires manual review.".into());
    }
    let mut transforms = Vec::new();
    for call in plugins.as_array_literal_expression().elements.nodes() {
        if call.kind() == Kind::CallExpression
            && call.as_call_expression().expression.kind() == Kind::Identifier
        {
            let name = call.as_call_expression().expression.text();
            if let Some(module) = imports.get(name)
                && module.starts_with("@vitejs/plugin-react")
            {
                transforms.push((*call, module));
            }
        }
    }
    if transforms.len() != 1 || transforms[0].1 != "@vitejs/plugin-react" {
        return Err("Set the JSX import source in the active React transform manually.".into());
    }
    let call = transforms[0].0;
    let arguments = call.as_call_expression().arguments.nodes();
    let mut text = source.to_owned();
    if arguments.is_empty() {
        text.insert_str(
            end(call) - 1,
            "{ jsxImportSource: \"@cross-css/vite/react\" }",
        );
        return Ok(text);
    }
    if arguments.len() != 1 || arguments[0].kind() != Kind::ObjectLiteralExpression {
        return Err("Set jsxImportSource explicitly in the React plugin options.".into());
    }
    let options = arguments[0];
    if let Some(mode) = property(options, "jsxRuntime")?
        && (mode.kind() != Kind::StringLiteral || mode.text() != "automatic")
    {
        return Err("Resolve the existing React JSX runtime options before applying setup.".into());
    }
    if let Some(value) = property(options, "jsxImportSource")? {
        if value.kind() != Kind::StringLiteral
            || !["react", "@cross-css/vite/react"].contains(&value.text())
        {
            return Err(
                "Resolve the existing React JSX import source before applying setup.".into(),
            );
        }
        if value.text() != "@cross-css/vite/react" {
            text.replace_range(
                start(source, value)..end(value),
                "\"@cross-css/vite/react\"",
            );
        }
    } else {
        let separator = if options
            .as_object_literal_expression()
            .properties
            .nodes()
            .is_empty()
        {
            " "
        } else {
            ", "
        };
        text.insert_str(
            start(source, options) + 1,
            &format!(" jsxImportSource: \"@cross-css/vite/react\"{separator}"),
        );
    }
    Ok(text)
}

fn property(object: P<Node>, name: &str) -> Result<Option<P<Node>>, String> {
    let mut found = None;
    for node in object.as_object_literal_expression().properties.nodes() {
        if node.kind() != Kind::PropertyAssignment {
            return Err(
                "Use explicit, unique properties in the Vite config before applying setup.".into(),
            );
        }
        let property = node.as_property_assignment();
        if !matches!(
            property.name().kind(),
            Kind::Identifier | Kind::StringLiteral
        ) {
            return Err("Computed Vite properties require manual review.".into());
        }
        if property.name().text() == name {
            if found.is_some() {
                return Err("Duplicate Vite properties require manual review.".into());
            }
            found = Some(property.initializer());
        }
    }
    Ok(found)
}

#[cfg(test)]
pub fn edit(source: &str, react: bool) -> Result<String, String> {
    edit_config(source, react, None)
}

pub fn edit_config(source: &str, react: bool, config: Option<&str>) -> Result<String, String> {
    let file = tsrs_parser::parse_source_file(
        SourceFileParseOptions {
            file_name: "/vite.config.ts".into(),
            ..Default::default()
        },
        source,
        ScriptKind::TS,
    );
    if !file.diagnostics().is_empty() {
        return Err("Fix the Vite config syntax before applying setup.".into());
    }
    let mut imports = BTreeMap::new();
    let mut config_names = Vec::new();
    let mut lazy_names = Vec::new();
    let mut object = None;
    let mut legacy_import = None;
    for statement in file.statements.nodes() {
        if statement.kind() == Kind::ImportDeclaration {
            let import = statement.as_import_declaration();
            let module = import.module_specifier.text();
            if let Some(clause) = import.import_clause() {
                let clause = clause.as_import_clause();
                if module == "@cross-css/vite-plugin" {
                    if clause.named_bindings.is_some() || clause.name.is_none() {
                        return Err("Migrate the existing legacy XCSS import manually.".into());
                    }
                    legacy_import = Some((
                        import.module_specifier,
                        clause.name.unwrap().text().to_owned(),
                    ));
                }
                if let Some(name) = clause.name {
                    imports.insert(name.text().to_owned(), module.to_owned());
                }
                if ["vite", "vite-plus"].contains(&module)
                    && let Some(bindings) = clause.named_bindings
                    && bindings.kind() == Kind::NamedImports
                {
                    for specifier in bindings.as_named_imports().elements.nodes() {
                        let s = specifier.as_import_specifier();
                        if s.property_name().unwrap_or(s.name()).text() == "defineConfig" {
                            config_names.push(s.name().text().to_owned());
                        }
                        if module == "vite-plus"
                            && s.property_name().unwrap_or(s.name()).text() == "lazyPlugins"
                        {
                            lazy_names.push(s.name().text().to_owned());
                        }
                    }
                }
            }
        }
        if statement.kind() == Kind::ExportAssignment {
            let mut expr = statement.as_export_assignment().expression();
            while matches!(
                expr.kind(),
                Kind::ParenthesizedExpression | Kind::AsExpression | Kind::SatisfiesExpression
            ) {
                expr = expr.expression().ok_or("Unsupported Vite export")?;
            }
            if expr.kind() == Kind::CallExpression {
                let call = expr.as_call_expression();
                if call.expression.kind() != Kind::Identifier
                    || !config_names.iter().any(|n| n == call.expression.text())
                    || call.arguments.nodes().len() != 1
                {
                    return Err("Dynamic Vite export requires manual review.".into());
                }
                expr = call.arguments.nodes()[0];
            }
            if expr.kind() != Kind::ObjectLiteralExpression {
                return Err("Dynamic Vite export requires manual review.".into());
            }
            object = Some(expr);
        }
    }
    let object = object.ok_or("No static default Vite export found")?;
    let mut plugins = property(object, "plugins")?;
    if let Some(value) = plugins
        && value.kind() == Kind::CallExpression
    {
        let call = value.as_call_expression();
        if call.expression.kind() == Kind::Identifier
            && lazy_names.iter().any(|name| name == call.expression.text())
            && call.arguments.nodes().len() == 1
        {
            let factory = call.arguments.nodes()[0];
            if factory.kind() == Kind::ArrowFunction
                && factory
                    .as_arrow_function()
                    .parameters()
                    .is_none_or(|p| p.nodes().is_empty())
                && factory.as_arrow_function().modifiers().is_none()
            {
                plugins = factory.as_arrow_function().body();
            }
        }
    }
    if let Some((specifier, binding)) = legacy_import {
        let list = plugins
            .filter(|p| p.kind() == Kind::ArrayLiteralExpression)
            .ok_or("Migrate the legacy registration manually.")?;
        let calls: Vec<_> = list
            .as_array_literal_expression()
            .elements
            .nodes()
            .iter()
            .filter(|call| {
                call.kind() == Kind::CallExpression
                    && call.as_call_expression().expression.kind() == Kind::Identifier
                    && call.as_call_expression().expression.text() == binding
            })
            .collect();
        if calls.len() != 1
            || !calls[0].as_call_expression().arguments.nodes().is_empty()
            || imports.values().any(|module| module == "@cross-css/vite")
        {
            return Err("Migrate the existing legacy XCSS registration manually.".into());
        }
        let mut text = source.to_owned();
        text.replace_range(
            start(source, specifier)..end(specifier),
            "\"@cross-css/vite\"",
        );
        return edit_config(&text, react, config);
    }
    if react {
        return edit_config(&react_options(source, plugins, &imports)?, false, config);
    }
    let mut binding = imports
        .iter()
        .find(|(_, module)| module.as_str() == "@cross-css/vite")
        .map(|(name, _)| name.clone());
    if let Some(plugins) = plugins {
        if plugins.kind() != Kind::ArrayLiteralExpression {
            return Err("Computed Vite plugin lists require manual review.".into());
        }
        let calls = plugins.as_array_literal_expression().elements.nodes();
        let mut count = 0;
        for call in calls {
            if call.kind() != Kind::CallExpression
                || call.as_call_expression().expression.kind() != Kind::Identifier
            {
                return Err("Unresolved Vite plugins require manual review.".into());
            }
            let name = call.as_call_expression().expression.text();
            let module = imports.get(name).ok_or("Unresolved Vite plugin import")?;
            if module == "@cross-css/vite" {
                count += 1;
            }
        }
        if count > 1 {
            return Err("Keep a single XCSS plugin registration.".into());
        }
        if count == 1 {
            if let Some(config) = config {
                let call = *calls
                    .iter()
                    .find(|call| {
                        imports
                            .get(call.as_call_expression().expression.text())
                            .is_some_and(|m| m == "@cross-css/vite")
                    })
                    .unwrap();
                let args = call.as_call_expression().arguments.nodes();
                if args.len() > 1
                    || args
                        .first()
                        .is_some_and(|arg| arg.kind() != Kind::ObjectLiteralExpression)
                {
                    return Err(
                        "Point the existing XCSS call at the application tsconfig manually.".into(),
                    );
                }
                let mut text = source.to_owned();
                let quoted = serde_json::to_string(config).unwrap();
                if let Some(options) = args.first() {
                    if let Some(value) = property(*options, "tsconfig")? {
                        if value.kind() != Kind::StringLiteral || value.text() != config {
                            return Err("Check the existing XCSS tsconfig option against the selected application config.".into());
                        }
                    } else {
                        let separator = if options
                            .as_object_literal_expression()
                            .properties
                            .nodes()
                            .is_empty()
                        {
                            " "
                        } else {
                            ", "
                        };
                        text.insert_str(
                            start(source, *options) + 1,
                            &format!(" tsconfig: {quoted}{separator}"),
                        );
                        return edit_config(&text, false, Some(config));
                    }
                } else {
                    text.insert_str(end(call) - 1, &format!("{{ tsconfig: {quoted} }}"));
                    return edit_config(&text, false, Some(config));
                }
            }
            let xcss = calls
                .iter()
                .position(|call| {
                    imports
                        .get(call.as_call_expression().expression.text())
                        .is_some_and(|m| m == "@cross-css/vite")
                })
                .unwrap();
            let jsx = calls.iter().position(|call| {
                imports
                    .get(call.as_call_expression().expression.text())
                    .is_some_and(|m| m.starts_with("@vitejs/plugin-react"))
            });
            if let Some(jsx) = jsx
                && xcss > jsx
            {
                let moved = calls[xcss];
                let begin = start(source, moved);
                let finish = end(moved);
                let next = tsrs_scanner::skip_trivia(source, finish as u32) as usize;
                let comma = if source[next..].starts_with(',') {
                    next
                } else {
                    tsrs_scanner::skip_trivia(source, end(calls[xcss - 1]) as u32) as usize
                };
                if !source[comma..].starts_with(',') {
                    return Err("Move XCSS before the React transform manually.".into());
                }
                let mut text = source.to_owned();
                if comma >= finish {
                    text.remove(comma);
                    text.replace_range(begin..finish, "");
                } else {
                    text.replace_range(begin..finish, "");
                    text.remove(comma);
                }
                text.insert_str(
                    start(source, calls[jsx]),
                    &format!("{}, ", &source[begin..finish]),
                );
                return Ok(text);
            }
            return Ok(source.into());
        }
    }
    let needs_import = binding.is_none();
    if binding.is_none() {
        let mut candidate = "xcss".to_owned();
        let mut suffix = 2;
        while file.has_identifier(candidate.as_str()) {
            candidate = format!("xcss{suffix}");
            suffix += 1;
        }
        binding = Some(candidate);
    }
    let binding = binding.unwrap();
    let invocation = config.map_or_else(
        || format!("{binding}()"),
        |config| {
            format!(
                "{binding}({{ tsconfig: {} }})",
                serde_json::to_string(config).unwrap()
            )
        },
    );
    let mut text = source.to_owned();
    // Node.pos includes leading trivia; find the opening token inside the AST range.
    let container = plugins.unwrap_or(object);
    let opening = if plugins.is_some() { '[' } else { '{' };
    let start = tsrs_scanner::skip_trivia(
        source,
        container
            .pos()
            .source_offset()
            .ok_or("Invalid node range")?,
    ) as usize;
    if !source[start..].starts_with(opening) {
        return Err("Missing Vite container".into());
    }
    let offset = start + 1;
    let insertion = if let Some(plugins) = plugins {
        format!(
            "{invocation}{}",
            if plugins
                .as_array_literal_expression()
                .elements
                .nodes()
                .is_empty()
            {
                ""
            } else {
                ", "
            }
        )
    } else {
        format!(
            " plugins: [{invocation}]{}",
            if object
                .as_object_literal_expression()
                .properties
                .nodes()
                .is_empty()
            {
                " "
            } else {
                ", "
            }
        )
    };
    text.insert_str(offset, &insertion);
    if needs_import {
        text.insert_str(0, &format!("import {binding} from \"@cross-css/vite\";\n"));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrates_legacy_import_and_targets_the_selected_application() {
        let source = "import { defineConfig, lazyPlugins as lazy } from 'vite-plus'; import css from '@cross-css/vite-plugin'; import react from '@vitejs/plugin-react'; export default defineConfig({ plugins: lazy(() => [css(), react()]) });";
        let edited = edit_config(source, true, Some("./tsconfig.app.json")).unwrap();
        assert!(!edited.contains("@cross-css/vite-plugin"));
        assert!(edited.contains("css({ tsconfig: \"./tsconfig.app.json\" })"));
        assert!(edited.contains("jsxImportSource: \"@cross-css/vite/react\""));
        assert_eq!(
            edit_config(&edited, true, Some("./tsconfig.app.json")).unwrap(),
            edited
        );
        assert!(edit_config(&edited, true, Some("./other.json")).is_err());
    }
    #[test]
    fn react_and_lazy_plugins_preserve_other_entries_and_are_idempotent() {
        let source = "import { defineConfig as cfg, lazyPlugins as lazy } from 'vite-plus';\nimport react from '@vitejs/plugin-react';\nimport colors from 'colors-plugin';\nimport css from '@cross-css/vite';\nexport default cfg({ plugins: lazy(() => [react({ fastRefresh: true }), colors(), css()]), server: { port: 3001 } });";
        let edited = edit(source, true).unwrap();
        assert!(edited.contains("[css(), react({ jsxImportSource: \"@cross-css/vite/react\",  fastRefresh: true }), colors()"),"{edited}");
        assert!(edited.contains("server: { port: 3001 }"));
        assert_eq!(edit(&edited, true).unwrap(), edited);
    }
    #[test]
    fn conflicting_react_options_never_produce_an_edit() {
        for options in [
            "{ jsxImportSource: 'other-runtime' }",
            "{ jsxRuntime: 'classic' }",
            "getOptions()",
        ] {
            let source = format!(
                "import react from '@vitejs/plugin-react'; export default {{ plugins: [react({options})] }};"
            );
            assert!(edit(&source, true).is_err());
        }
    }
    #[test]
    fn preserves_other_settings_and_reuses_imports() {
        let source = "// 😀 keep this\nimport { defineConfig as cfg } from 'vite';\nimport colors from 'colors-plugin';\nexport default cfg({ plugins: [colors()], server: { port: 3001 } });";
        let edited = edit(source, false).unwrap();
        assert!(edited.contains("plugins: [xcss(), colors()]"));
        assert!(edited.contains("// 😀 keep this"));
        assert!(edited.contains("server: { port: 3001 }"));
        assert_eq!(edit(&edited, false).unwrap(), edited);
    }
    #[test]
    fn avoids_collisions_and_rejects_dynamic_and_ambiguous_configs() {
        let source =
            "const xcss = 1; export default /* { misleading comment */ { plugins: /* [ */ [] };";
        assert!(edit(source, false).unwrap().contains("xcss2()"));
        for source in [
            "export default () => ({ plugins: [] })",
            "export default { plugins: getPlugins() }",
            "export default { plugins: [], plugins: [] }",
            "export default { ...config }",
            "export default { ['plugins']: [] }",
        ] {
            assert!(edit(source, false).is_err(), "{source}");
        }
    }
}
