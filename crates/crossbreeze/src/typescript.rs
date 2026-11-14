//! Scope-aware highlighting of locally imported XCSS containers.
use tsrs_ast::{Kind, Node, SourceFileParseOptions, Symbol, SymbolFlags};
use tsrs_core::{P, ScriptKind};
use xcss_language_service::SemanticToken;

pub fn import_tokens(text: &str) -> Vec<SemanticToken> {
    let region = tsrs_core::arena::Region::new(1 << 20);
    let _scope = region.enter();
    let file = tsrs_parser::parse_source_file(
        SourceFileParseOptions {
            file_name: "/source.tsx".into(),
            ..Default::default()
        },
        text,
        ScriptKind::TSX,
    );
    tsrs_binder::bind_source_file(file);
    let mut symbols = Vec::new();
    for statement in file.statements.nodes() {
        if statement.kind() != Kind::ImportDeclaration {
            continue;
        }
        let import = statement.as_import_declaration();
        if !import.module_specifier.text().ends_with(".xcss") {
            continue;
        }
        let Some(clause) = import.import_clause() else {
            continue;
        };
        let Some(bindings) = clause.as_import_clause().named_bindings else {
            continue;
        };
        if bindings.kind() != Kind::NamedImports {
            continue;
        }
        for item in bindings.as_named_imports().elements.nodes() {
            let specifier = item.as_import_specifier();
            if ["styles", "cssVars"]
                .contains(&specifier.property_name().unwrap_or(specifier.name()).text())
                && let Some(symbol) = file
                    .locals()
                    .and_then(|locals| (*locals).get(specifier.name().text()))
            {
                symbols.push(symbol);
            }
        }
    }
    let resolver = tsrs_binder::NameResolver::<()>::new(P::new(Default::default()), None);
    let source = xcss_source::SourceFile::new(xcss_source::FileId("source.tsx".into()), 1, text);
    let mut tokens = Vec::new();
    fn visit(
        node: P<Node>,
        symbols: &[P<Symbol>],
        resolver: &tsrs_binder::NameResolver<()>,
        file: P<tsrs_ast::SourceFile>,
        source: &xcss_source::SourceFile,
        tokens: &mut Vec<SemanticToken>,
    ) {
        let property = node.parent().is_some_and(|p| match p.kind() {
            Kind::PropertyAccessExpression => p.as_property_access_expression().name == node,
            Kind::PropertyAssignment => p.as_property_assignment().name() == node,
            _ => false,
        });
        if node.kind() == Kind::Identifier
            && !property
            && resolver
                .resolve(
                    &mut (),
                    Some(node),
                    node.text(),
                    SymbolFlags::Value | SymbolFlags::Alias,
                    None,
                    true,
                    true,
                )
                .is_some_and(|symbol| symbols.contains(&symbol))
        {
            let begin = tsrs_scanner::get_token_pos_of_node(node, file, false) as usize;
            let finish = node.end().source_offset().unwrap() as usize;
            if let Some(position) = source.byte_to_utf16(begin) {
                tokens.push(SemanticToken {
                    line: position.line,
                    character: position.character,
                    length: source.text()[begin..finish].encode_utf16().count(),
                    token_type: xcss_language_service::TOKEN_TYPES
                        .iter()
                        .position(|t| *t == "xcssImport")
                        .unwrap(),
                    declaration: false,
                });
            }
        }
        node.for_each_child(&mut |child| {
            visit(child, symbols, resolver, file, source, tokens);
            false
        });
    }
    visit(
        file.as_node(),
        &symbols,
        &resolver,
        file,
        &source,
        &mut tokens,
    );
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_and_uses_highlight_but_shadowed_names_and_properties_do_not() {
        let text = "import { styles as s, cssVars } from './a.xcss'; s.button; cssVars.size; function local(s: any) { s.button; } const obj = { s: 1 }; obj.s;";
        let tokens = import_tokens(text);
        let highlighted: Vec<_> = tokens
            .iter()
            .map(|t| &text[t.character..t.character + t.length])
            .collect();
        assert_eq!(highlighted, vec!["s", "cssVars", "s", "cssVars"]);
    }
}
