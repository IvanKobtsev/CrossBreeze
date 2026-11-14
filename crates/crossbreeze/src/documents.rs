//! Open document overlays with LSP UTF-16 incremental synchronization.
use std::collections::HashMap;
use xcss_source::Position;

#[derive(Clone, Debug)]
pub struct Document {
    pub version: i64,
    pub text: String,
    pub language_id: String,
}

pub struct Change {
    /// None replaces the complete document.
    pub range: Option<(Position, Position)>,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SyncError {
    NotOpen,
    StaleVersion,
    InvalidRange,
}

#[derive(Default)]
pub struct Documents(HashMap<String, Document>);

impl Documents {
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Document)> {
        self.0
            .iter()
            .map(|(uri, document)| (uri.as_str(), document))
    }
    pub fn get(&self, uri: &str) -> Option<&Document> {
        self.0.get(uri)
    }

    pub fn open(&mut self, uri: String, document: Document) -> Result<(), SyncError> {
        if self
            .0
            .get(&uri)
            .is_some_and(|old| old.version >= document.version)
        {
            return Err(SyncError::StaleVersion);
        }
        self.0.insert(uri, document);
        Ok(())
    }

    /// Changes are sequential within a notification and commit atomically.
    pub fn change(&mut self, uri: &str, version: i64, changes: &[Change]) -> Result<(), SyncError> {
        let document = self.0.get_mut(uri).ok_or(SyncError::NotOpen)?;
        if version <= document.version {
            return Err(SyncError::StaleVersion);
        }
        let mut text = document.text.clone();
        for change in changes {
            if let Some((start, end)) = change.range {
                let start = byte_offset(&text, start).ok_or(SyncError::InvalidRange)?;
                let end = byte_offset(&text, end).ok_or(SyncError::InvalidRange)?;
                if start > end {
                    return Err(SyncError::InvalidRange);
                }
                text.replace_range(start..end, &change.text);
            } else {
                text.clone_from(&change.text);
            }
        }
        document.text = text;
        document.version = version;
        Ok(())
    }

    pub fn close(&mut self, uri: &str) -> Option<Document> {
        self.0.remove(uri)
    }
}

/// Reject positions inside surrogate pairs or beyond the logical line end.
pub fn byte_offset(text: &str, position: Position) -> Option<usize> {
    let mut line = 0;
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while line < position.line {
        let (offset, ch) = chars.next()?;
        if ch == '\r' {
            start = offset + 1;
            if chars.peek().is_some_and(|(_, next)| *next == '\n') {
                start = chars.next()?.0 + 1;
            }
            line += 1;
        } else if ch == '\n' {
            start = offset + 1;
            line += 1;
        }
    }
    let mut units = 0;
    for (offset, ch) in text[start..].char_indices() {
        if units == position.character {
            return Some(start + offset);
        }
        if ch == '\r' || ch == '\n' {
            return None;
        }
        units += ch.len_utf16();
    }
    (units == position.character).then_some(text.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(line: usize, character: usize) -> Position {
        Position { line, character }
    }

    #[test]
    fn positions_handle_unicode_and_all_line_endings() {
        let text = "a😀\r\nb\rc\n";
        assert_eq!(byte_offset(text, p(0, 3)), Some(5));
        assert_eq!(byte_offset(text, p(0, 2)), None);
        assert_eq!(byte_offset(text, p(0, 4)), None);
        assert_eq!(byte_offset(text, p(1, 0)), Some(7));
        assert_eq!(byte_offset(text, p(2, 0)), Some(9));
        assert_eq!(byte_offset(text, p(3, 0)), Some(text.len()));
        assert_eq!(byte_offset(text, p(4, 0)), None);
    }

    #[test]
    fn edits_are_sequential_atomic_and_versioned() {
        let mut docs = Documents::default();
        docs.open(
            "file:///a".into(),
            Document {
                version: 1,
                text: "😀x".into(),
                language_id: "xcss".into(),
            },
        )
        .unwrap();
        docs.change(
            "file:///a",
            2,
            &[
                Change {
                    range: Some((p(0, 0), p(0, 2))),
                    text: "ab".into(),
                },
                Change {
                    range: Some((p(0, 2), p(0, 3))),
                    text: "c".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(docs.get("file:///a").unwrap().text, "abc");
        assert_eq!(
            docs.change("file:///a", 2, &[]),
            Err(SyncError::StaleVersion)
        );
        assert_eq!(
            docs.change(
                "file:///a",
                3,
                &[
                    Change {
                        range: None,
                        text: "new".into()
                    },
                    Change {
                        range: Some((p(9, 0), p(9, 1))),
                        text: "bad".into()
                    },
                ]
            ),
            Err(SyncError::InvalidRange)
        );
        assert_eq!(docs.get("file:///a").unwrap().text, "abc");
        assert_eq!(docs.get("file:///a").unwrap().version, 2);
        docs.close("file:///a");
        assert_eq!(docs.change("file:///a", 4, &[]), Err(SyncError::NotOpen));
    }
}
