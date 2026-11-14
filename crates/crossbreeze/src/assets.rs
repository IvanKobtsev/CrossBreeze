//! Asset references are extracted only from engine-identified CSS value contexts.
use xcss_language_service::{CssValues, Range};
use xcss_source::Position;

pub struct Asset {
    pub value: String,
    pub range: Range,
}

fn advance(mut position: Position, text: &str) -> Position {
    for c in text.chars() {
        if c == '\n' {
            position.line += 1;
            position.character = 0;
        } else {
            position.character += c.len_utf16();
        }
    }
    position
}

pub fn urls(values: &CssValues) -> Vec<Asset> {
    fn visit(text: &str, base: Position, output: &mut Vec<Asset>) {
        let mut input = cssparser::ParserInput::new(text);
        let mut parser = cssparser::Parser::new(&mut input);
        loop {
            parser.skip_whitespace();
            let begin = parser.position().byte_index();
            let Ok(token) = parser.next().cloned() else {
                break;
            };
            let value = match token {
                cssparser::Token::UnquotedUrl(value) => Some(value.to_string()),
                cssparser::Token::Function(name) if name.eq_ignore_ascii_case("url") => parser
                    .parse_nested_block(|nested| {
                        let value = nested.expect_string_cloned()?.to_string();
                        nested.expect_exhausted()?;
                        Ok::<_, cssparser::ParseError<'_, ()>>(value)
                    })
                    .ok(),
                cssparser::Token::Function(_) => {
                    let inner_start = parser.position().byte_index();
                    let _: Result<(), cssparser::ParseError<'_, ()>> =
                        parser.parse_nested_block(|nested| {
                            while nested.next().is_ok() {}
                            Ok(())
                        });
                    let finish = parser.position().byte_index();
                    if finish > inner_start {
                        visit(
                            &text[inner_start..finish - 1],
                            advance(base, &text[..inner_start]),
                            output,
                        );
                    }
                    None
                }
                _ => None,
            };
            if let Some(value) = value {
                let end = parser.position().byte_index();
                let raw = &text[begin..end];
                let Some(open) = raw.find('(') else {
                    continue;
                };
                let Some(close) = raw.rfind(')') else {
                    continue;
                };
                let inside = &raw[open + 1..close];
                let trimmed = inside.trim();
                let leading = inside.len() - inside.trim_start().len();
                let quoted = trimmed.starts_with(['\'', '"']);
                let start = begin + open + 1 + leading + usize::from(quoted);
                let finish = begin + open + 1 + leading + trimmed.len() - usize::from(quoted);
                if finish > start {
                    output.push(Asset {
                        value,
                        range: Range {
                            start: advance(base, &text[..start]),
                            end: advance(base, &text[..finish]),
                        },
                    });
                }
            }
        }
    }
    let mut result = Vec::new();
    for value in &values.values {
        let mut found = Vec::new();
        visit(&value.text, value.range.start, &mut found);
        result.extend(found.into_iter().filter(|asset| {
            !value.parts.iter().any(|part| {
                part.value_type.is_some()
                    && (part.range.start.line, part.range.start.character)
                        < (asset.range.end.line, asset.range.end.character)
                    && (asset.range.start.line, asset.range.start.character)
                        < (part.range.end.line, part.range.end.character)
            })
        }));
    }
    result
}

pub fn local_path(value: &str) -> Option<String> {
    if value.is_empty() || value.starts_with(['#']) || value.starts_with("//") {
        return None;
    }
    let scheme = value.split(['/', '?', '#']).next().unwrap_or("");
    if scheme.contains(':') {
        return None;
    }
    let path = value.split(['?', '#']).next()?;
    if path.is_empty() {
        return None;
    }
    Some(
        percent_encoding::percent_decode_str(path)
            .decode_utf8()
            .map_or_else(|_| path.into(), |s| s.into_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls_preserve_utf16_ranges_and_decode_escapes_without_matching_strings() {
        let text = "/* 😀 */ .a { background: url(\"a b😀.png?raw#icon\"); content: \"url(fake.png)\"; mask: url(a\\ b.png); }";
        let mut service = crate::LanguageService::new();
        let file = xcss_source::FileId("test.xcss".into());
        service.set_file(file.clone(), 1, text.into()).unwrap();
        let urls = urls(&service.snapshot().css_values(&file));
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].value, "a b😀.png?raw#icon");
        assert_eq!(
            urls[0].range.start.character,
            text[..text.find("a b😀").unwrap()].encode_utf16().count()
        );
        assert_eq!(urls[1].value, "a b.png");
        assert_eq!(local_path("a%20b.png?raw"), Some("a b.png".into()));
        for value in [
            "",
            "#icon",
            "data:image/png;base64,abc",
            "https://example.com/a.png",
            "//cdn/a.png",
        ] {
            assert!(local_path(value).is_none());
        }
    }
}
