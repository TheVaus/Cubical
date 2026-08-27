const PropertyRefsDoc = () => (
  <>
    <p class="set-doc__lead">
      A wiki link that names a frontmatter key renders as that key's{" "}
      <em>value</em>, inline in the prose. It keeps one fact in one place: write
      the value in a note's frontmatter, reference it everywhere else.
    </p>

    <h3 class="set-doc__h3">Two forms</h3>
    <dl class="set-doc__dl">
      <dt>
        <code>[[Ann.role]]</code>
      </dt>
      <dd>
        The value of <code>role</code> in the frontmatter of Ann.md.
      </dd>
      <dt>
        <code>[[.role]]</code>
      </dt>
      <dd>
        The value of <code>role</code> in the note you are writing — no name
        before the dot.
      </dd>
    </dl>

    <h3 class="set-doc__h3">Example</h3>
    <pre class="set-doc__pre">
      {`# Ann.md
---
role: Staff engineer
team: Platform
---

# Any other note
Ann is a [[Ann.role]] on [[Ann.team]].`}
    </pre>
    <p>
      That last line reads “Ann is a Staff engineer on Platform.” Change the
      frontmatter in <code>Ann.md</code> and every note referencing it updates.
    </p>

    <h3 class="set-doc__h3">What renders</h3>
    <p>
      Text, numbers, and <code>true</code>/<code>false</code> render as
      themselves. A list renders comma-separated. A nested map has no inline
      form, so it stays unresolved.
    </p>
    <p>
      A reference that cannot be resolved — no such note, or no such key — stays
      visible as its raw <code>[[…]]</code> text with a dashed underline, so a
      typo is obvious rather than silent.
    </p>

    <h3 class="set-doc__h3">Editing</h3>
    <p>
      Put the cursor on a line and its references turn back into source for as
      long as you are there, so there is always a way to edit the link itself.
    </p>

    <h3 class="set-doc__h3">One thing to watch</h3>
    <p class="set-doc__note">
      The dot is what distinguishes a reference from an ordinary link, and the
      split happens at the <em>first</em> dot. That makes{" "}
      <code>[[Notes.md]]</code> a reference to an <code>md</code> property, not a link to a
      file. Write wiki links without the <code>.md</code> extension — which is
      the normal form anyway — and this never bites. Links carrying a{" "}
      <code>#heading</code> anchor and embeds (<code>![[…]]</code>) are always
      treated as links.
    </p>
  </>
);

export default PropertyRefsDoc;
