//! LSP stdio framing. Protocol output must never contain log messages.
use std::io::{self, BufRead, Write};

const MAX_MESSAGE: usize = 32 * 1024 * 1024;
const MAX_HEADERS: usize = 8192;

pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut length = None;
    let mut bytes = 0;
    loop {
        let mut line = Vec::new();
        loop {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                if bytes == 0 && line.is_empty() {
                    return Ok(None);
                }
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let count = available
                .iter()
                .position(|b| *b == b'\n')
                .map_or(available.len(), |n| n + 1);
            if bytes + count > MAX_HEADERS {
                return Err(invalid("LSP headers too large"));
            }
            line.extend_from_slice(&available[..count]);
            reader.consume(count);
            bytes += count;
            if line.last() == Some(&b'\n') {
                break;
            }
        }
        let line = std::str::from_utf8(&line)
            .map_err(|_| invalid("Invalid LSP header"))?
            .trim();
        if line.is_empty() {
            break;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid("Invalid LSP header"))?;
        if name.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                return Err(invalid("Duplicate Content-Length"));
            }
            let parsed: usize = value
                .trim()
                .parse()
                .map_err(|_| invalid("Invalid Content-Length"))?;
            if parsed > MAX_MESSAGE {
                return Err(invalid("LSP message too large"));
            }
            length = Some(parsed);
        }
    }
    let mut body = vec![0; length.ok_or_else(|| invalid("Missing Content-Length"))?];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_message(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)?;
    writer.flush()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn concatenated_unicode_messages_round_trip() {
        let mut stream = Vec::new();
        write_message(&mut stream, "😀".as_bytes()).unwrap();
        write_message(&mut stream, b"{}").unwrap();
        let mut reader = Cursor::new(stream);
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), "😀".as_bytes());
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), b"{}");
        assert!(read_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn malformed_and_truncated_input_is_rejected() {
        for input in [
            "Content-Length: -1\r\n\r\n",
            "Content-Length: 999999999\r\n\r\n",
            "Content-Length: 1\r\nContent-Length: 1\r\n\r\na",
            "Content-Type: application/json\r\n\r\n",
            "Content-Length: 3\r\n\r\nx",
            "Content-Length: 3",
        ] {
            assert!(read_message(&mut Cursor::new(input)).is_err(), "{input}");
        }
    }
}
