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
            let text = text.strip_suffix("!important").unwrap_or(text).trim();
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
                    warning = if typed.len() == 1 && literal.trim().is_empty() {
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

pub fn colors(input: &xcss_language_service::CssValues) -> Vec<Value> {
    let mut result = Vec::new();
    for value in &input.values {
        if !value.checkable {
            continue;
        }
        let color_context = value.property.as_deref().is_none_or(|p| {
            p.contains("color")
                || [
                    "background",
                    "border",
                    "outline",
                    "box-shadow",
                    "text-shadow",
                    "fill",
                    "stroke",
                ]
                .contains(&p)
        });
        if !color_context {
            continue;
        }
        for part in &value.parts {
            let Some(text) = part.text.as_deref() else {
                continue;
            };
            let mut input = cssparser::ParserInput::new(text);
            let mut parser = cssparser::Parser::new(&mut input);
            loop {
                parser.skip_whitespace();
                let start = parser.position().byte_index();
                let Ok(token) = parser.next().cloned() else {
                    break;
                };
                if matches!(token, cssparser::Token::Function(_)) {
                    let _: Result<(), cssparser::ParseError<'_, ()>> =
                        parser.parse_nested_block(|nested| {
                            while nested.next().is_ok() {}
                            Ok(())
                        });
                }
                let end = parser.position().byte_index();
                if let Some([red, green, blue, alpha]) = parse_color(&text[start..end]) {
                    let advance = |offset: usize| {
                        let mut p = part.range.start;
                        for c in text[..offset].chars() {
                            if c == '\n' {
                                p.line += 1;
                                p.character = 0;
                            } else {
                                p.character += c.len_utf16();
                            }
                        }
                        p
                    };
                    result.push(json!({"color":{"red":red,"green":green,"blue":blue,"alpha":alpha},"range":range(&Range { start:advance(start), end:advance(end) })}));
                }
            }
        }
    }
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
