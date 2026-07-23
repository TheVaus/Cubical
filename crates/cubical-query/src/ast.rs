#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    List,
    Table(Vec<String>),
    Count,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    Tag(String),
    Folder(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Num(f64),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cond {
    pub key: String,
    pub op: Op,
    pub value: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sort {
    pub key: String,
    pub dir: SortDir,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub command: Command,
    pub source: Option<Source>,
    pub conds: Vec<Cond>,
    pub sort: Option<Sort>,
}
