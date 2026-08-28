const MathDoc = () => (
  <>
    <p class="set-doc__lead">
      LaTeX typeset with KaTeX, rendered in place as you write. Nothing is
      written back to the file — the Markdown on disk stays the LaTeX you typed.
    </p>

    <dl class="set-doc__help">
      <dt>```math … ```</dt>
      <dd>a fenced block, typeset centred on its own</dd>
      <dt>```latex, ```katex</dt>
      <dd>the same block under either alias</dd>
      <dt>$$ … $$</dt>
      <dd>the same, opened and closed inline in the prose</dd>
      <dt>\begin{"{aligned}"} …</dt>
      <dd>multi-line environments, as KaTeX supports them</dd>
      <dt>cursor inside</dt>
      <dd>turns the expression back into source to edit</dd>
      <dt>a parse error</dt>
      <dd>shown in place, in monospace, never swallowed</dd>
    </dl>

    <h3 class="set-doc__h3">Two ways to write it</h3>
    <p>
      A fenced block tagged <code>math</code> (or <code>latex</code>,{" "}
      <code>katex</code>) renders centred as its own block:
    </p>
    <pre class="set-doc__pre">
      {`\`\`\`math
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt\\pi}{2}
\`\`\``}
    </pre>
    <p>
      Or wrap the expression in <code>$$</code> — on one line, or opening and
      closing on lines of their own:
    </p>
    <pre class="set-doc__pre">
      {`$$E = mc^2$$

$$
\\begin{aligned}
a &= b + c \\\\
  &= d
\\end{aligned}
$$`}
    </pre>
    <p class="set-doc__note">
      Both forms are display math. Inline <code>$…$</code> inside a sentence is
      not recognised — use a <code>$$</code> block on its own line instead.
    </p>

    <h3 class="set-doc__h3">Editing</h3>
    <p>
      Move the cursor into a rendered expression and it turns back into source
      until you leave it. Typing a fence offers <code>math</code> in the
      language autocomplete.
    </p>

    <h3 class="set-doc__h3">Errors and escapes</h3>
    <p>
      An expression KaTeX cannot parse shows its error message in place, in
      monospace, instead of disappearing. An empty block says so rather than
      collapsing to nothing.
    </p>
    <p>
      <code>$$</code> inside a fenced code block is left alone, so you can still
      write about the syntax without it rendering. Turning this plugin off
      leaves every expression as plain text.
    </p>
  </>
);

export default MathDoc;
