//! The query AST — the parser's output, the planner's input.

/// The projection command: what shape the result takes.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// One note link per matching file.
    List,
    /// A column per named frontmatter key (plus an implicit file column).
    Table(Vec<String>),
    /// The number of matching files.
    Count,
}

/// The `FROM` source restricting the candidate file set.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// `#tag` — files carrying this tag or a descendant (prefix match).
    Tag(String),
    /// `"folder/path"` — files whose path is under this folder.
    Folder(String),
}

/// A comparison operator in a `WHERE` condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// `=`
    Eq,
    /// `!=`
    Ne,
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
}

/// A literal value on the right-hand side of a condition.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// A double-quoted string literal.
    Str(String),
    /// A numeric literal (int or float; stored as f64).
    Num(f64),
    /// A bare `true` / `false`.
    Bool(bool),
}

/// One `WHERE` condition: `key op value`.
#[derive(Debug, Clone, PartialEq)]
pub struct Cond {
    /// The frontmatter key being compared.
    pub key: String,
    /// The comparison operator.
    pub op: Op,
    /// The literal compared against.
    pub value: Value,
}

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    /// Ascending (default).
    Asc,
    /// Descending.
    Desc,
}

/// The `SORT` clause: a single frontmatter key + direction.
#[derive(Debug, Clone, PartialEq)]
pub struct Sort {
    /// The frontmatter key to sort by.
    pub key: String,
    /// The sort direction.
    pub dir: SortDir,
}

/// A fully parsed query.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    /// The projection command.
    pub command: Command,
    /// The `FROM` source, or `None` for "all files".
    pub source: Option<Source>,
    /// `WHERE` conditions, implicitly AND-joined (possibly empty).
    pub conds: Vec<Cond>,
    /// The `SORT` clause, or `None`.
    pub sort: Option<Sort>,
}
