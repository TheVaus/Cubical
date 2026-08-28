const EquationsDoc = () => (
  <>
    <p class="set-doc__lead">
      Arithmetic that stays live. A number written as an equation keeps
      following the values it came from — including values in other notes.
      Nothing is written back to the file; the Markdown on disk stays the
      expression you typed.
    </p>

    <dl class="set-doc__help">
      <dt>`= 5-3`</dt>
      <dd>an inline code span starting with =, rendered as its result</dd>
      <dt>`= [[note.prop]] - 3`</dt>
      <dd>an operand read from another note's frontmatter</dd>
      <dt>`= [[.prop]] * 2`</dt>
      <dd>an operand read from this note's own frontmatter</dd>
      <dt>```calc</dt>
      <dd>a block, one expression per line, each shown beside its result</dd>
      <dt>cursor inside</dt>
      <dd>turns the expression back into source to edit</dd>
      <dt>not an expression</dt>
      <dd>left alone as ordinary inline code</dd>
    </dl>

    <h3 class="set-doc__h3">Why not just type the number</h3>
    <p>
      Because a typed number is wrong the moment its source changes, and nothing
      tells you. With <code>age: 5</code> in <code>dan.md</code>, writing{" "}
      <code>`= [[dan.age]] - 3`</code> renders <strong>2</strong> — and when{" "}
      <code>age</code> becomes 6, every note that referred to it becomes 3 on its
      own, with no reload.
    </p>

    <h3 class="set-doc__h3">What counts as a number</h3>
    <p>
      A property is usable in arithmetic when its YAML value is a number.{" "}
      <code>age: 5</code> computes; <code>age: "5"</code> and{" "}
      <code>age: banana</code> report <em>not a number</em> rather than guessing.
      Quoting is the difference, and it is deliberate — the type comes from the
      file, so what you wrote is what you get.
    </p>

    <h3 class="set-doc__h3">Operators</h3>
    <p>
      <code>+</code> <code>-</code> <code>*</code> <code>/</code> <code>%</code>{" "}
      and parentheses, with the usual precedence. Dates, durations, units and
      functions are not part of this — each is filed as its own issue rather
      than half-built here.
    </p>

    <h3 class="set-doc__h3">Errors</h3>
    <p>
      A missing note, a missing property, a non-numeric value or a division by
      zero is named in place rather than left blank. An inline code span that is
      not an expression is not an error at all — writing{" "}
      <code>`=SUM(A1:B2)`</code> about a spreadsheet renders unchanged.
    </p>

    <p class="set-doc__note">
      Equations read frontmatter through property references, so this plugin
      needs that one switched on. Turning equations off leaves every expression
      as plain text.
    </p>
  </>
);

export default EquationsDoc;
