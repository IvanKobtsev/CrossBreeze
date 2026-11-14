//! CSS advisory validation over source-preserving engine projections.
use lightningcss::{
    properties::{Property, PropertyId},
    stylesheet::ParserOptions,
};
use serde_json::{Value, json};
use xcss_language_service::{CssDeclarations, CssValuePart, Range};

fn range(r: &Range) -> Value {
    json!({"start":{"line":r.start.line,"character":r.start.character},"end":{"line":r.end.line,"character":r.end.character}})
}
fn representative(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "number" | "integer" => "1",
        "length" | "length-percentage" => "1px",
        "percentage" => "1%",
        "angle" => "1deg",
        "time" => "1s",
        "frequency" => "1Hz",
        "resolution" => "1dppx",
        "flex" => "1fr",
        "color" => "red",
        "image" => "linear-gradient(red, blue)",
        "url" => "url(\"data:,\")",
        "transform-function" | "transform-list" => "matrix(1, 0, 0, 1, 0, 0)",
        _ => return None,
    })
}
fn project(parts: &[CssValuePart]) -> Option<String> {
    parts
        .iter()
        .map(|part| {
            part.value_type.as_deref().map_or_else(
                || part.text.clone(),
                |kind| representative(kind).map(str::to_owned),
            )
        })
        .collect()
}

fn without_important(text: &str) -> &str {
    let mut input = cssparser::ParserInput::new(text);
    let mut parser = cssparser::Parser::new(&mut input);
    loop {
        parser.skip_whitespace();
        let start = parser.position().byte_index();
        let Ok(token) = parser.next().cloned() else {
            return text.trim();
        };
        if matches!(token, cssparser::Token::Delim('!'))
            && parser.expect_ident_matching("important").is_ok()
            && parser.expect_exhausted().is_ok()
        {
            return text[..start].trim();
        }
    }
}
fn empty_literal(text: &str) -> bool {
    let mut input = cssparser::ParserInput::new(without_important(text));
    cssparser::Parser::new(&mut input).next().is_err()
}
fn precise_range(property: &str, parts: &[CssValuePart]) -> Option<Range> {
    let text = project(parts)?;
    fn tokens(text: &str, base: usize, result: &mut Vec<(usize, usize)>) {
        let mut input = cssparser::ParserInput::new(text);
        let mut parser = cssparser::Parser::new(&mut input);
        loop {
            parser.skip_whitespace();
            let begin = parser.position().byte_index();
            let Ok(token) = parser.next().cloned() else {
                break;
            };
            if matches!(token, cssparser::Token::Function(_)) {
                let inner = parser.position().byte_index();
                let _: Result<(), cssparser::ParseError<'_, ()>> =
                    parser.parse_nested_block(|nested| {
                        while nested.next().is_ok() {}
                        Ok(())
                    });
                let end = parser.position().byte_index();
                if end > inner {
                    tokens(&text[inner..end - 1], base + inner, result);
                }
            } else if matches!(
                token,
                cssparser::Token::Ident(_)
                    | cssparser::Token::Hash(_)
                    | cssparser::Token::IDHash(_)
                    | cssparser::Token::Dimension { .. }
                    | cssparser::Token::Number { .. }
                    | cssparser::Token::Percentage { .. }
            ) {
                result.push((base + begin, base + parser.position().byte_index()));
            }
        }
    }
    let mut candidates = Vec::new();
    tokens(&text, 0, &mut candidates);
    let (begin,end)=candidates.into_iter().find(|(begin,end)| {
        ["initial","red","transparent","solid","1px","1","1s","none"].iter().any(|replacement| {
            let candidate=format!("{}{}{}",&text[..*begin],replacement,&text[*end..]);
            matches!(Property::parse_string(PropertyId::from(property),without_important(&candidate),ParserOptions::default()),Ok(value) if !matches!(value,Property::Unparsed(_)))
        })
    })?;
    let advance = |mut p: xcss_source::Position, text: &str| {
        for ch in text.chars() {
            if ch == '\n' {
                p.line += 1;
                p.character = 0;
            } else {
                p.character += ch.len_utf16();
            }
        }
        p
    };
    let mut offset = 0;
    let mut start = None;
    let mut finish = None;
    for part in parts {
        let value: &str = if let Some(kind) = part.value_type.as_deref() {
            representative(kind)?
        } else {
            part.text.as_deref()?
        };
        let limit = offset + value.len();
        if offset <= begin && begin < limit {
            start = Some(if part.value_type.is_some() {
                part.range.start
            } else {
                advance(part.range.start, &value[..begin - offset])
            });
        }
        if offset < end && end <= limit {
            finish = Some(if part.value_type.is_some() {
                part.range.end
            } else {
                advance(part.range.start, &value[..end - offset])
            });
        }
        offset = limit;
    }
    Some(Range {
        start: start?,
        end: finish?,
    })
}

pub fn validate(input: &CssDeclarations, properties: bool, values: bool) -> Vec<Value> {
    let mut result = Vec::new();
    for declaration in &input.declarations {
        if declaration.property.starts_with("--") {
            continue;
        }
        let property = PropertyId::from(declaration.property.as_str());
        let mut warning = None;
        if matches!(property, PropertyId::Custom(_)) {
            if properties {
                warning = Some((
                    format!("Unknown CSS property “{}”.", declaration.property),
                    &declaration.property_range,
                ));
            }
        } else if values
            && declaration.checkable
            && let Some(text) = project(&declaration.parts)
        {
            let text = text.trim();
            let text = without_important(text);
            let wide = ["inherit", "initial", "unset", "revert", "revert-layer"].contains(&text);
            if !wide && !text.contains("var(") && !text.contains("env(") {
                let parsed = Property::parse_string(property, text, ParserOptions::default());
                if parsed.is_err() || matches!(parsed, Ok(Property::Unparsed(_))) {
                    let typed: Vec<_> = declaration
                        .parts
                        .iter()
                        .filter(|p| p.value_type.is_some())
                        .collect();
                    let literal = declaration
                        .parts
                        .iter()
                        .filter_map(|p| p.text.as_deref())
                        .collect::<String>();
                    warning = if typed.len() == 1 && empty_literal(&literal) {
                        Some((
                            format!(
                                "A value of type “{}” is not valid for CSS property “{}”.",
                                typed[0].value_type.as_ref().unwrap(),
                                declaration.property
                            ),
                            &typed[0].range,
                        ))
                    } else {
                        Some((
                            format!("Invalid CSS value for “{}”.", declaration.property),
                            &declaration.value_range,
                        ))
                    };
                }
            }
        }
        if let Some((message, source_range)) = warning {
            let precise = if message.starts_with("Invalid CSS value") {
                precise_range(&declaration.property, &declaration.parts)
            } else {
                None
            };
            let source_range = precise.as_ref().unwrap_or(source_range);
            result.push(
                json!({"source":"CSS","severity":2,"message":message,"range":range(source_range)}),
            );
        }
    }
    result
}

pub fn parse_color(text: &str) -> Option<[f64; 4]> {
    let mut input = cssparser::ParserInput::new(text);
    let mut parser = cssparser::Parser::new(&mut input);
    let color = cssparser_color::Color::parse(&mut parser).ok()?;
    parser.expect_exhausted().ok()?;
    match color {
        cssparser_color::Color::Rgba(c) => Some([
            c.red as f64 / 255.,
            c.green as f64 / 255.,
            c.blue as f64 / 255.,
            c.alpha as f64,
        ]),
        cssparser_color::Color::Hsl(c) => {
            let h = c.hue? as f64 / 60.;
            let s = c.saturation? as f64;
            let l = c.lightness? as f64;
            let chroma = (1. - (2. * l - 1.).abs()) * s;
            let x = chroma * (1. - (h.rem_euclid(2.) - 1.).abs());
            let m = l - chroma / 2.;
            let (r, g, b) = match h.rem_euclid(6.) as usize {
                0 => (chroma, x, 0.),
                1 => (x, chroma, 0.),
                2 => (0., chroma, x),
                3 => (0., x, chroma),
                4 => (x, 0., chroma),
                _ => (chroma, 0., x),
            };
            Some([r + m, g + m, b + m, c.alpha.unwrap_or(1.) as f64])
        }
        _ => None,
    }
}

fn advance(mut p: xcss_source::Position, text: &str) -> xcss_source::Position {
    for ch in text.chars() {
        if ch == '\n' {
            p.line += 1;
            p.character = 0;
        } else {
            p.character += ch.len_utf16();
        }
    }
    p
}

pub fn colors(input: &xcss_language_service::CssValues) -> Vec<Value> {
    fn scan(text: &str, base: xcss_source::Position, out: &mut Vec<Value>) {
        let mut input = cssparser::ParserInput::new(text);
        let mut parser = cssparser::Parser::new(&mut input);
        loop {
            parser.skip_whitespace();
            let begin = parser.position().byte_index();
            let Ok(token) = parser.next().cloned() else {
                break;
            };
            let function = match &token {
                cssparser::Token::Function(name) => Some(name.to_ascii_lowercase()),
                _ => None,
            };
            let inner = parser.position().byte_index();
            if function.is_some() {
                let _: Result<(), cssparser::ParseError<'_, ()>> =
                    parser.parse_nested_block(|nested| {
                        while nested.next().is_ok() {}
                        Ok(())
                    });
            }
            let end = parser.position().byte_index();
            if let Some([red, green, blue, alpha]) = parse_color(&text[begin..end]) {
                out.push(json!({"color":{"red":red,"green":green,"blue":blue,"alpha":alpha},"range":range(&Range {start:advance(base,&text[..begin]),end:advance(base,&text[..end])})}));
            } else if function.is_some_and(|name| name.ends_with("gradient"))
                && end > inner
                && text[..end].ends_with(')')
            {
                scan(&text[inner..end - 1], advance(base, &text[..inner]), out);
            }
        }
    }
    let mut result = Vec::new();
    for value in &input.values {
        if !value.checkable {
            continue;
        }
        let context = value.property.as_deref().is_none_or(|p| {
            !p.starts_with("--")
                && (p.contains("color")
                    || p.ends_with("image")
                    || p.starts_with("border")
                    || [
                        "background",
                        "outline",
                        "box-shadow",
                        "text-shadow",
                        "fill",
                        "stroke",
                    ]
                    .contains(&p))
        });
        if !context {
            continue;
        }
        let mut found = Vec::new();
        scan(&value.text, value.range.start, &mut found);
        result.extend(found.into_iter().filter(|color| {
            let start = (
                color["range"]["start"]["line"].as_u64().unwrap() as usize,
                color["range"]["start"]["character"].as_u64().unwrap() as usize,
            );
            let end = (
                color["range"]["end"]["line"].as_u64().unwrap() as usize,
                color["range"]["end"]["character"].as_u64().unwrap() as usize,
            );
            !value.parts.iter().any(|p| {
                p.value_type.is_some()
                    && (p.range.start.line, p.range.start.character) < end
                    && start < (p.range.end.line, p.range.end.character)
            })
        }));
    }
    result
}

pub fn tokens(
    input: &xcss_language_service::CssValues,
) -> Vec<xcss_language_service::SemanticToken> {
    let mut result = Vec::new();
    let mut add = |r: &Range, kind: &str| {
        if r.start.line == r.end.line && r.end.character > r.start.character {
            result.push(xcss_language_service::SemanticToken {
                line: r.start.line,
                character: r.start.character,
                length: r.end.character - r.start.character,
                token_type: xcss_language_service::TOKEN_TYPES
                    .iter()
                    .position(|k| *k == kind)
                    .unwrap(),
                declaration: false,
            });
        }
    };
    for value in &input.values {
        for function in &value.functions {
            add(&function.range, "cssFunction");
        }
        if let Some(property) = value.property.as_deref()
            && !["font-family", "animation-name", "--"]
                .iter()
                .any(|p| property.starts_with(p))
        {
            for part in &value.parts {
                let Some(text) = part.text.as_deref() else {
                    continue;
                };
                let mut input = cssparser::ParserInput::new(text);
                let mut parser = cssparser::Parser::new(&mut input);
                loop {
                    parser.skip_whitespace();
                    let begin = parser.position().byte_index();
                    let Ok(token) = parser.next().cloned() else {
                        break;
                    };
                    let end = parser.position().byte_index();
                    if matches!(token, cssparser::Token::Ident(_))
                        && parse_color(&text[begin..end]).is_none()
                        && matches!(Property::parse_string(PropertyId::from(property),&text[begin..end],ParserOptions::default()),Ok(p) if !matches!(p,Property::Custom(_)|Property::Unparsed(_)))
                    {
                        add(
                            &Range {
                                start: advance(part.range.start, &text[..begin]),
                                end: advance(part.range.start, &text[..end]),
                            },
                            "cssKeyword",
                        );
                    }
                }
            }
        }
    }
    for color in colors(input) {
        let r = &color["range"];
        let start = xcss_source::Position {
            line: r["start"]["line"].as_u64().unwrap() as usize,
            character: r["start"]["character"].as_u64().unwrap() as usize,
        };
        let end = xcss_source::Position {
            line: r["end"]["line"].as_u64().unwrap() as usize,
            character: r["end"]["character"].as_u64().unwrap() as usize,
        };
        let range = input
            .values
            .iter()
            .flat_map(|v| &v.functions)
            .find(|f| f.range.start == start)
            .map_or(Range { start, end }, |f| f.range.clone());
        result.retain(|t| {
            !(t.line == range.start.line
                && t.character < range.end.character
                && range.start.character < t.character + t.length)
        });
        if range.start.line == range.end.line {
            result.push(xcss_language_service::SemanticToken {
                line: range.start.line,
                character: range.start.character,
                length: range.end.character - range.start.character,
                token_type: xcss_language_service::TOKEN_TYPES
                    .iter()
                    .position(|k| *k == "cssColor")
                    .unwrap(),
                declaration: false,
            });
        }
    }
    result.sort_by_key(|t| (t.line, t.character));
    result
}
pub fn presentation(original: &str, color: [f64; 4], source_range: Value) -> Vec<Value> {
    if color
        .iter()
        .any(|c| !c.is_finite() || !(0.0..=1.0).contains(c))
    {
        return vec![];
    }
    let [r, g, b, a] = color;
    let number = |v: f64| {
        let formatted = format!("{v:.4}");
        formatted
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    };
    let alpha = if a < 1.0 {
        format!(" / {}", number(a))
    } else {
        String::new()
    };
    let label = if original
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("hsl")
    {
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let d = max - min;
        let l = (max + min) / 2.;
        let h = if d == 0. {
            0.
        } else if max == r {
            ((g - b) / d).rem_euclid(6.) * 60.
        } else if max == g {
            ((b - r) / d + 2.) * 60.
        } else {
            ((r - g) / d + 4.) * 60.
        };
        let s = if d == 0. {
            0.
        } else {
            d / (1. - (2. * l - 1.).abs())
        };
        format!(
            "hsl({} {}% {}%{})",
            number(h),
            number(s * 100.),
            number(l * 100.),
            alpha
        )
    } else if original
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("rgb")
    {
        format!(
            "rgb({} {} {}{})",
            number(r * 255.),
            number(g * 255.),
            number(b * 255.),
            alpha
        )
    } else {
        let mut hex = format!(
            "#{:02x}{:02x}{:02x}",
            (r * 255.).round() as u8,
            (g * 255.).round() as u8,
            (b * 255.).round() as u8
        );
        if a < 1. {
            hex.push_str(&format!("{:02x}", (a * 255.).round() as u8));
        }
        hex
    };
    vec![json!({"label":label,"textEdit":{"range":source_range,"newText":label}})]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_integration_preserves_ranges_and_does_not_expose_representatives() {
        let text = "/* 😀 */\n@vars { --size: length = 1px; --t: time = 1s; }\n@injection paint($p: time = 1s) { width: $p; }\n.a {\n  width: --t !important;\n  border: --size solid red;\n  color: rgb(1 2 3 / .5);\n  animation-duration: --t + --t;\n  @media (width > 1px) { display: fex; }\n  height: var(--external, 1px);\n  transition: (opacity, color) 1s;\n  --custom: arbitrary tokens;\n  content: preserve;\n}\n@font-face { font-family: arbitrary; src: url(font.woff); }\n@property --other { syntax: \"<color>\"; inherits: false; initial-value: red; }";
        let mut service = crate::LanguageService::new();
        let file = xcss_source::FileId("integration.xcss".into());
        service.set_file(file.clone(), 1, text.into()).unwrap();
        let warnings = validate(&service.snapshot().css_declarations(&file), true, true);
        assert_eq!(warnings.len(), 3, "{warnings:#?}");
        assert!(
            warnings[0]["message"]
                .as_str()
                .unwrap()
                .starts_with("A value of type")
        );
        assert!(
            warnings[1]["message"]
                .as_str()
                .unwrap()
                .starts_with("A value of type")
        );
        assert_eq!(warnings[0]["range"]["start"]["line"], 2);
        assert_eq!(warnings[1]["range"]["start"]["line"], 4);
        assert_eq!(warnings[2]["range"]["start"]["line"], 8);
        assert!(
            warnings
                .iter()
                .all(|w| !w["message"].as_str().unwrap().contains("1s"))
        );
    }
    #[test]
    fn important_is_case_insensitive_and_allows_comments() {
        for text in [
            "flex !important",
            "flex ! /* comment */ IMPORTANT",
            "flex !important /*tail*/",
        ] {
            assert_eq!(without_important(text), "flex");
        }
        assert!(empty_literal(" /* 😀 */ !important"));
    }
    #[test]
    fn contextual_gradient_colors_and_keywords_exclude_custom_names_and_strings() {
        let text = "$tone = red; @vars { --accent: color = #fff; } @injection paint($c: color = hsl(120 100% 50%)) {} .a { position: relative; cursor: pointer; outline: none; background: linear-gradient(red, rgb(0 0 255 / 50%)); transform: translateY(-25.5px); filter: blur(2px); animation-name: pointer; font-family: red; content: \"blue\"; color: --accent; }";
        let mut service = crate::LanguageService::new();
        let file = xcss_source::FileId("values.xcss".into());
        service.set_file(file.clone(), 1, text.into()).unwrap();
        let values = service.snapshot().css_values(&file);
        assert_eq!(colors(&values).len(), 5);
        let tokens = tokens(&values);
        let keywords: Vec<_> = tokens
            .iter()
            .filter(|t| xcss_language_service::TOKEN_TYPES[t.token_type] == "cssKeyword")
            .map(|t| &text[t.character..t.character + t.length])
            .collect();
        assert_eq!(keywords, vec!["relative", "pointer", "none"]);
        for name in ["linear-gradient", "translateY", "blur"] {
            assert!(
                tokens
                    .iter()
                    .any(|t| &text[t.character..t.character + t.length] == name)
            );
        }
    }
    #[test]
    fn title_button_has_exactly_two_css_errors_and_corrected_source_is_valid() {
        let source = include_str!("../tests/fixtures/title-button.xcss");
        let check = |text: &str| {
            let mut service = crate::LanguageService::new();
            let file = xcss_source::FileId("title.xcss".into());
            service.set_file(file.clone(), 1, text.into()).unwrap();
            validate(&service.snapshot().css_declarations(&file), true, true)
        };
        let errors = check(source);
        assert_eq!(errors.len(), 2, "{errors:#?}");
        assert_eq!(
            errors[0]["range"]["end"]["character"].as_u64().unwrap()
                - errors[0]["range"]["start"]["character"].as_u64().unwrap(),
            "transprent".len() as u64
        );
        let corrected = source
            .replace("transprent", "transparent")
            .replace("10ss0%", "100%");
        assert!(check(&corrected).is_empty(), "{:#?}", check(&corrected));
    }
    #[test]
    fn advisory_validation_respects_settings_and_typed_values() {
        use xcss_source::{FileId, Position};
        let mut service = crate::LanguageService::new();
        let file = FileId("test.xcss".into());
        service
            .set_file(
                file.clone(),
                1,
                ".button { dispay: flex; display: fex; color: red; }".into(),
            )
            .unwrap();
        let snapshot = service.snapshot();
        let input = snapshot.css_declarations(&file);
        let warnings = validate(&input, true, true);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(
            warnings[0]["message"]
                .as_str()
                .unwrap()
                .starts_with("Unknown CSS property")
        );
        assert_eq!(validate(&input, false, true).len(), 1);
        assert_eq!(validate(&input, true, false).len(), 1);
        assert!(validate(&input, false, false).is_empty());
        let colors = colors(&snapshot.css_values(&file));
        assert_eq!(colors.len(), 1);
        let source_range = Range {
            start: Position {
                line: 0,
                character: 0,
            },
            end: Position {
                line: 0,
                character: 4,
            },
        };
        let typed = CssDeclarations {
            revision: 1,
            declarations: vec![xcss_language_service::CssDeclaration {
                property: "width".into(),
                property_range: source_range.clone(),
                value_range: source_range.clone(),
                context: "rule".into(),
                checkable: true,
                parts: vec![CssValuePart {
                    text: None,
                    value_type: Some("time".into()),
                    range: source_range,
                }],
            }],
        };
        assert!(
            validate(&typed, true, true)[0]["message"]
                .as_str()
                .unwrap()
                .starts_with("A value of type")
        );
    }
    #[test]
    fn colors_include_names_hex_rgb_and_hsl() {
        for color in ["red", "#f00", "rgb(255 0 0)", "hsl(0 100% 50%)"] {
            assert_eq!(parse_color(color), Some([1., 0., 0., 1.]));
        }
        assert_eq!(parse_color("transparent"), Some([0., 0., 0., 0.]));
        assert!(parse_color("currentColor").is_none());
    }
}
