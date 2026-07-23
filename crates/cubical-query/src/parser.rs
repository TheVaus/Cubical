use crate::ast::{Command, Cond, Op, Query, Sort, SortDir, Source, Value};
use crate::error::ParseError;

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Word(String),
    Str(String),
    Num(f64),
    Tag(String),
    Op(Op),
    Comma,
}

fn tokenize(src: &str) -> Result<Vec<Tok>, ParseError> {
    let mut out = Vec::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            c if c.is_whitespace() => i += 1,
            ',' => {
                out.push(Tok::Comma);
                i += 1;
            }
            '=' => {
                out.push(Tok::Op(Op::Eq));
                i += 1;
            }
            '!' => {
                if chars.get(i + 1) == Some(&'=') {
                    out.push(Tok::Op(Op::Ne));
                    i += 2;
                } else {
                    return Err(ParseError::new("expected `=` after `!`"));
                }
            }
            '<' => {
                if chars.get(i + 1) == Some(&'=') {
                    out.push(Tok::Op(Op::Le));
                    i += 2;
                } else {
                    out.push(Tok::Op(Op::Lt));
                    i += 1;
                }
            }
            '>' => {
                if chars.get(i + 1) == Some(&'=') {
                    out.push(Tok::Op(Op::Ge));
                    i += 2;
                } else {
                    out.push(Tok::Op(Op::Gt));
                    i += 1;
                }
            }
            '"' => {
                let mut s = String::new();
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(ParseError::new("unterminated string literal")),
                        Some('"') => {
                            i += 1;
                            break;
                        }
                        Some(&ch) => {
                            s.push(ch);
                            i += 1;
                        }
                    }
                }
                out.push(Tok::Str(s));
            }
            '#' => {
                i += 1;
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || matches!(chars[i], '/' | '-' | '_'))
                {
                    i += 1;
                }
                if i == start {
                    return Err(ParseError::new("expected a tag after `#`"));
                }
                out.push(Tok::Tag(chars[start..i].iter().collect()));
            }
            c if c.is_ascii_digit()
                || (c == '-' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())) =>
            {
                let start = i;
                i += 1;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let raw: String = chars[start..i].iter().collect();
                let n = raw
                    .parse::<f64>()
                    .map_err(|_| ParseError::new(format!("invalid number `{raw}`")))?;
                out.push(Tok::Num(n));
            }
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '-' | '.'))
                {
                    i += 1;
                }
                out.push(Tok::Word(chars[start..i].iter().collect()));
            }
            other => return Err(ParseError::new(format!("unexpected character `{other}`"))),
        }
    }
    Ok(out)
}

pub fn parse(src: &str) -> Result<Query, ParseError> {
    let toks = tokenize(src)?;
    let mut p = Parser { toks, pos: 0 };
    let q = p.parse_query()?;
    if p.pos != p.toks.len() {
        return Err(ParseError::new("unexpected trailing input"));
    }
    Ok(q)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }
    fn bump(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn eat_kw(&mut self, kw: &str) -> bool {
        if let Some(Tok::Word(w)) = self.peek() {
            if w.eq_ignore_ascii_case(kw) {
                self.pos += 1;
                return true;
            }
        }
        false
    }

    fn parse_query(&mut self) -> Result<Query, ParseError> {
        let command = self.parse_command()?;
        let source = self.parse_from()?;
        let conds = self.parse_where()?;
        let sort = self.parse_sort()?;
        Ok(Query {
            command,
            source,
            conds,
            sort,
        })
    }

    fn parse_command(&mut self) -> Result<Command, ParseError> {
        match self.bump() {
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("list") => Ok(Command::List),
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("count") => Ok(Command::Count),
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("table") => {
                let cols = self.parse_column_list()?;
                Ok(Command::Table(cols))
            }
            _ => Err(ParseError::new("expected LIST, TABLE, or COUNT")),
        }
    }

    fn parse_column_list(&mut self) -> Result<Vec<String>, ParseError> {
        let mut cols = Vec::new();
        loop {
            match self.peek() {
                Some(Tok::Word(w)) => {
                    cols.push(w.clone());
                    self.pos += 1;
                }
                _ => return Err(ParseError::new("expected a column name after TABLE")),
            }
            if matches!(self.peek(), Some(Tok::Comma)) {
                self.pos += 1;
            } else {
                break;
            }
        }
        Ok(cols)
    }

    fn parse_from(&mut self) -> Result<Option<Source>, ParseError> {
        if !self.eat_kw("from") {
            return Ok(None);
        }
        match self.bump() {
            Some(Tok::Tag(t)) => Ok(Some(Source::Tag(t))),
            Some(Tok::Str(s)) => Ok(Some(Source::Folder(s))),
            _ => Err(ParseError::new("expected #tag or \"folder\" after FROM")),
        }
    }

    fn parse_where(&mut self) -> Result<Vec<Cond>, ParseError> {
        if !self.eat_kw("where") {
            return Ok(Vec::new());
        }
        let mut conds = vec![self.parse_cond()?];
        while self.eat_kw("and") {
            conds.push(self.parse_cond()?);
        }
        Ok(conds)
    }

    fn parse_cond(&mut self) -> Result<Cond, ParseError> {
        let key = match self.bump() {
            Some(Tok::Word(w)) => w,
            _ => return Err(ParseError::new("expected a frontmatter key in WHERE")),
        };
        let op = match self.bump() {
            Some(Tok::Op(op)) => op,
            _ => {
                return Err(ParseError::new(
                    "expected a comparison operator (=, !=, <, <=, >, >=)",
                ))
            }
        };
        let value = self.parse_value()?;
        Ok(Cond { key, op, value })
    }

    fn parse_value(&mut self) -> Result<Value, ParseError> {
        match self.bump() {
            Some(Tok::Str(s)) => Ok(Value::Str(s)),
            Some(Tok::Num(n)) => Ok(Value::Num(n)),
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("true") => Ok(Value::Bool(true)),
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("false") => Ok(Value::Bool(false)),
            _ => Err(ParseError::new("expected a string, number, or true/false")),
        }
    }

    fn parse_sort(&mut self) -> Result<Option<Sort>, ParseError> {
        if !self.eat_kw("sort") {
            return Ok(None);
        }
        let key = match self.bump() {
            Some(Tok::Word(w)) => w,
            _ => return Err(ParseError::new("expected a frontmatter key after SORT")),
        };
        let dir = if self.eat_kw("desc") {
            SortDir::Desc
        } else {
            self.eat_kw("asc");
            SortDir::Asc
        };
        Ok(Some(Sort { key, dir }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_list() {
        let q = parse("LIST").unwrap();
        assert_eq!(q.command, Command::List);
        assert_eq!(q.source, None);
        assert!(q.conds.is_empty());
        assert_eq!(q.sort, None);
    }

    #[test]
    fn parses_count() {
        assert_eq!(parse("COUNT").unwrap().command, Command::Count);
        assert_eq!(parse("count").unwrap().command, Command::Count);
    }

    #[test]
    fn parses_table_columns() {
        let q = parse("TABLE status, due_date").unwrap();
        assert_eq!(
            q.command,
            Command::Table(vec!["status".into(), "due_date".into()])
        );
    }

    #[test]
    fn table_without_columns_errors() {
        assert!(parse("TABLE").is_err());
    }

    #[test]
    fn parses_from_tag() {
        let q = parse("LIST FROM #project").unwrap();
        assert_eq!(q.source, Some(Source::Tag("project".into())));
    }

    #[test]
    fn parses_from_folder() {
        let q = parse(r#"LIST FROM "areas/health""#).unwrap();
        assert_eq!(q.source, Some(Source::Folder("areas/health".into())));
    }

    #[test]
    fn parses_where_single_cond() {
        let q = parse(r#"LIST WHERE status = "in-progress""#).unwrap();
        assert_eq!(
            q.conds,
            vec![Cond {
                key: "status".into(),
                op: Op::Eq,
                value: Value::Str("in-progress".into()),
            }]
        );
    }

    #[test]
    fn parses_where_and_chain_and_types() {
        let q = parse("LIST WHERE priority >= 2 AND done = true").unwrap();
        assert_eq!(
            q.conds,
            vec![
                Cond {
                    key: "priority".into(),
                    op: Op::Ge,
                    value: Value::Num(2.0)
                },
                Cond {
                    key: "done".into(),
                    op: Op::Eq,
                    value: Value::Bool(true)
                },
            ]
        );
    }

    #[test]
    fn where_without_key_errors() {
        assert!(parse("LIST WHERE = 3").is_err());
    }

    #[test]
    fn parses_sort_default_asc() {
        let q = parse("LIST SORT due_date").unwrap();
        assert_eq!(
            q.sort,
            Some(Sort {
                key: "due_date".into(),
                dir: SortDir::Asc
            })
        );
    }

    #[test]
    fn parses_sort_desc() {
        let q = parse("LIST SORT due_date DESC").unwrap();
        assert_eq!(
            q.sort,
            Some(Sort {
                key: "due_date".into(),
                dir: SortDir::Desc
            })
        );
    }

    #[test]
    fn parses_full_query() {
        let q =
            parse(r#"TABLE status, due_date FROM #project WHERE status = "in-progress" SORT due_date ASC"#)
                .unwrap();
        assert_eq!(
            q.command,
            Command::Table(vec!["status".into(), "due_date".into()])
        );
        assert_eq!(q.source, Some(Source::Tag("project".into())));
        assert_eq!(q.conds.len(), 1);
        assert_eq!(
            q.sort,
            Some(Sort {
                key: "due_date".into(),
                dir: SortDir::Asc
            })
        );
    }

    #[test]
    fn empty_input_errors() {
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
    }

    #[test]
    fn unknown_command_errors() {
        assert!(parse("FETCH status").is_err());
    }

    #[test]
    fn trailing_junk_errors() {
        assert!(parse("LIST garbage extra").is_err());
    }

    #[test]
    fn unterminated_string_errors() {
        assert!(parse(r#"LIST WHERE x = "oops"#).is_err());
    }
}
