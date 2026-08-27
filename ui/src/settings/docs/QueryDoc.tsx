const QueryDoc = () => (
  <>
    <p class="set-doc__lead">
      A fenced <code>query</code> block is replaced by its live result — a list
      of notes, a table of frontmatter values, or a single count. Results are
      recomputed from the index as notes change, so a query never goes stale.
    </p>

    <h3 class="set-doc__h3">Shape</h3>
    <pre class="set-doc__pre">
      {`LIST | TABLE key, key… | COUNT
[ FROM #tag | "folder" ]
[ WHERE key <op> value  [ AND key <op> value … ] ]
[ SORT key [ ASC | DESC ] ]`}
    </pre>
    <p>
      Only the first line is required, and keywords are case-insensitive —
      <code>list from #x</code> works as well as <code>LIST FROM #x</code>.
      Clauses must appear in this order.
    </p>

    <h3 class="set-doc__h3">The first line picks the output</h3>
    <dl class="set-doc__dl">
      <dt>
        <code>LIST</code>
      </dt>
      <dd>Every matching note as a clickable link.</dd>
      <dt>
        <code>TABLE due, status</code>
      </dt>
      <dd>
        One row per note. A <strong>File</strong> column is added for you; each
        further column is a frontmatter key, blank where a note lacks it.
      </dd>
      <dt>
        <code>COUNT</code>
      </dt>
      <dd>Just the number of matching notes.</dd>
    </dl>

    <h3 class="set-doc__h3">FROM narrows the candidates</h3>
    <p>
      <code>FROM #project</code> takes notes tagged <code>#project</code>{" "}
      <em>and</em> its nested tags, so <code>#project/web</code> is included.{" "}
      <code>FROM "Areas/Work"</code> takes every note under that folder,
      subfolders included — the path is quoted, and matched from the vault root.
      Omit <code>FROM</code> and the whole vault is the candidate set.
    </p>

    <h3 class="set-doc__h3">WHERE filters on frontmatter</h3>
    <p>
      Operators are <code>=</code>, <code>!=</code>, <code>&lt;</code>,{" "}
      <code>&lt;=</code>, <code>&gt;</code>, <code>&gt;=</code>. Values are
      quoted text, a number, or <code>true</code>/<code>false</code>. Join
      conditions with <code>AND</code> — there is no <code>OR</code> yet, and no
      grouping.
    </p>
    <p class="set-doc__note">
      A note that has no such key never matches, including under{" "}
      <code>!=</code>. To find notes missing a key, leave it out of the query
      and read the blank cells in a <code>TABLE</code>.
    </p>

    <h3 class="set-doc__h3">SORT orders the result</h3>
    <p>
      <code>SORT due DESC</code> sorts on a frontmatter key;{" "}
      <code>ASC</code> is the default. Notes missing the key sort last, and ties
      fall back to file path. Without <code>SORT</code>, results come back in
      path order. <code>COUNT</code> ignores sorting.
    </p>

    <h3 class="set-doc__h3">Worked examples</h3>
    <pre class="set-doc__pre">
      {`\`\`\`query
LIST
FROM #project
WHERE status = "active"
SORT due ASC
\`\`\``}
    </pre>
    <pre class="set-doc__pre">
      {`\`\`\`query
TABLE status, due, owner
FROM "Areas/Work"
WHERE archived = false AND priority >= 2
SORT priority DESC
\`\`\``}
    </pre>
    <pre class="set-doc__pre">
      {`\`\`\`query
COUNT FROM #inbox
\`\`\``}
    </pre>

    <h3 class="set-doc__h3">When it goes wrong</h3>
    <p>
      A query that does not parse renders a ⚠ message in place of the result,
      naming what was expected. The block itself is never rewritten — your
      Markdown is left exactly as you typed it. Turning this plugin off leaves
      every <code>query</code> block showing as plain code.
    </p>
  </>
);

export default QueryDoc;
