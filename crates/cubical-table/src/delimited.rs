use crate::error::TableError;
use crate::table::{Cell, Table};

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

pub(crate) fn decode(bytes: &[u8], delimiter: u8) -> Result<Table, TableError> {
    let body = bytes.strip_prefix(BOM).unwrap_or(bytes);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(body);

    let mut records = reader.records();
    let header = match records.next() {
        None => return Ok(Table::default()),
        Some(record) => record.map_err(as_error)?,
    };
    let columns: Vec<String> = header.iter().map(str::to_string).collect();
    let width = columns.len();

    let mut rows = Vec::new();
    for record in records {
        let record = record.map_err(as_error)?;
        let mut row: Vec<Cell> = record.iter().take(width).map(Cell::from_text).collect();
        row.resize(width, Cell::default());
        rows.push(row);
    }
    Ok(Table { columns, rows })
}

fn as_error(err: csv::Error) -> TableError {
    let message = err.to_string();
    match err.into_kind() {
        csv::ErrorKind::Io(io) => TableError::Io(io),
        _ => TableError::Decode(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMA: u8 = b',';
    const TAB: u8 = b'\t';

    fn csv(text: &str) -> Table {
        match decode(text.as_bytes(), COMMA) {
            Ok(table) => table,
            Err(err) => panic!("decode failed: {err}"),
        }
    }

    fn texts(row: &[Cell]) -> Vec<&str> {
        row.iter().map(|c| c.text.as_str()).collect()
    }

    #[test]
    fn reads_a_header_and_rows() {
        let table = csv("name,qty\nAlpha,2\nBeta,3\n");
        assert_eq!(table.columns, vec!["name", "qty"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(texts(&table.rows[0]), vec!["Alpha", "2"]);
        assert_eq!(table.rows[0][1].num, Some(2.0));
    }

    #[test]
    fn quoted_fields_may_contain_the_delimiter() {
        let table = csv("name,note\n\"Alpha, the first\",ok\n");
        assert_eq!(texts(&table.rows[0]), vec!["Alpha, the first", "ok"]);
    }

    #[test]
    fn quoted_fields_may_contain_newlines() {
        let table = csv("name,note\n\"two\nlines\",ok\n");
        assert_eq!(table.rows.len(), 1);
        assert_eq!(texts(&table.rows[0]), vec!["two\nlines", "ok"]);
    }

    #[test]
    fn quotes_are_escaped_by_doubling() {
        let table = csv("name,note\n\"say \"\"hi\"\"\",ok\n");
        assert_eq!(texts(&table.rows[0]), vec!["say \"hi\"", "ok"]);
    }

    #[test]
    fn crlf_line_endings_leave_no_carriage_return_behind() {
        let table = csv("name,qty\r\nAlpha,2\r\n");
        assert_eq!(table.columns, vec!["name", "qty"]);
        assert_eq!(texts(&table.rows[0]), vec!["Alpha", "2"]);
    }

    #[test]
    fn a_utf8_bom_is_not_part_of_the_first_column_name() {
        let mut bytes = BOM.to_vec();
        bytes.extend_from_slice(b"name,qty\nAlpha,2\n");
        let table = match decode(&bytes, COMMA) {
            Ok(table) => table,
            Err(err) => panic!("decode failed: {err}"),
        };
        assert_eq!(table.columns, vec!["name", "qty"]);
    }

    #[test]
    fn short_rows_are_padded_and_long_rows_truncated() {
        let table = csv("a,b,c\n1\n1,2,3,4,5\n");
        assert_eq!(table.rows[0].len(), 3);
        assert_eq!(texts(&table.rows[0]), vec!["1", "", ""]);
        assert!(table.rows[0][2].is_empty());
        assert_eq!(texts(&table.rows[1]), vec!["1", "2", "3"]);
    }

    #[test]
    fn an_empty_file_is_an_empty_table_not_an_error() {
        let table = csv("");
        assert!(table.columns.is_empty());
        assert!(table.rows.is_empty());
    }

    #[test]
    fn a_header_only_file_has_columns_and_no_rows() {
        let table = csv("a,b\n");
        assert_eq!(table.columns, vec!["a", "b"]);
        assert!(table.rows.is_empty());
    }

    #[test]
    fn duplicate_and_empty_column_names_survive() {
        let table = csv("a,,a\n1,2,3\n");
        assert_eq!(table.columns, vec!["a", "", "a"]);
        assert_eq!(table.column_index("a"), Some(0));
        assert_eq!(table.column_index(""), Some(1));
    }

    #[test]
    fn typing_applies_to_every_cell() {
        let table = csv("s,n,b,e\n007,1.5,TRUE,\n12abc,-3,false,  \n");
        assert_eq!(table.rows[0][0].text, "007");
        assert_eq!(table.rows[0][0].num, Some(7.0));
        assert_eq!(table.rows[0][1].num, Some(1.5));
        assert_eq!(table.rows[0][2].boolean, Some(true));
        assert!(table.rows[0][3].is_empty());
        assert_eq!(table.rows[1][0].num, None);
        assert_eq!(table.rows[1][1].num, Some(-3.0));
        assert_eq!(table.rows[1][2].boolean, Some(false));
        assert!(table.rows[1][3].is_empty());
    }

    #[test]
    fn tabs_separate_a_tsv() {
        let table = match decode(b"name\tqty\nAlpha\t2\n", TAB) {
            Ok(table) => table,
            Err(err) => panic!("decode failed: {err}"),
        };
        assert_eq!(table.columns, vec!["name", "qty"]);
        assert_eq!(texts(&table.rows[0]), vec!["Alpha", "2"]);
    }

    #[test]
    fn a_comma_is_just_text_in_a_tsv() {
        let table = match decode(b"a\tb\n1,2\t3\n", TAB) {
            Ok(table) => table,
            Err(err) => panic!("decode failed: {err}"),
        };
        assert_eq!(texts(&table.rows[0]), vec!["1,2", "3"]);
    }

    #[test]
    fn blank_lines_do_not_become_rows() {
        let table = csv("a,b\n1,2\n\n3,4\n");
        assert_eq!(table.rows.len(), 2);
    }

    #[test]
    fn invalid_utf8_is_a_decode_error() {
        let err = decode(b"a,b\n\xff\xfe,2\n", COMMA).unwrap_err();
        assert!(matches!(err, TableError::Decode(_)), "{err:?}");
    }
}
