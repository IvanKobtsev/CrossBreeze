use serde_json::Value;
use xcss_format::{EndOfLine, FormatOptions};

pub fn options(request: &Value, settings: &Value) -> Result<FormatOptions, String> {
    let width = settings
        .get("tabWidth")
        .unwrap_or(&request["tabSize"])
        .as_u64()
        .filter(|n| (1..=16).contains(n))
        .ok_or("Invalid tab width")?;
    let tabs = if let Some(tabs) = settings.get("useTabs") {
        tabs.as_bool().ok_or("Invalid useTabs")?
    } else {
        !request["insertSpaces"]
            .as_bool()
            .ok_or("Invalid insertSpaces")?
    };
    let print_width = request
        .get("crossbreeze.printWidth")
        .or_else(|| settings.get("printWidth"))
        .map_or(Some(80), Value::as_u64)
        .filter(|n| (1..=1000).contains(n))
        .ok_or("Invalid print width")?;
    let ending = request
        .get("crossbreeze.endOfLine")
        .or_else(|| settings.get("endOfLine"))
        .map_or(Some("lf"), Value::as_str)
        .ok_or("Invalid line ending")?;
    Ok(FormatOptions {
        tab_width: width as usize,
        use_tabs: tabs,
        print_width: print_width as usize,
        end_of_line: match ending {
            "lf" => EndOfLine::Lf,
            "crlf" => EndOfLine::Crlf,
            _ => return Err("Invalid line ending".into()),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ide_settings_and_explicit_options_have_the_existing_precedence() {
        let value = options(
            &json!({"tabSize":4,"insertSpaces":true,"crossbreeze.printWidth":60}),
            &json!({"tabWidth":2,"useTabs":true,"printWidth":100,"endOfLine":"crlf"}),
        )
        .unwrap();
        assert_eq!(
            (
                value.tab_width,
                value.use_tabs,
                value.print_width,
                value.end_of_line
            ),
            (2, true, 60, EndOfLine::Crlf)
        );
        assert!(options(&json!({"tabSize":0,"insertSpaces":true}), &Value::Null).is_err());
    }
}
