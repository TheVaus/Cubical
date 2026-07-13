import { createSignal, For } from 'solid-js';
import SegmentedControl from '../../components/forms/SegmentedControl/SegmentedControl';
import BacklinkRow from '../../components/data/BacklinkRow/BacklinkRow';
import { backlinks, unlinkedMentions } from '../../fixtures/backlinks';
import './RightSidebar.css';

const RightSidebar = () => {
  const [tab, setTab] = createSignal('backlinks');

  return (
    <aside class="right-sidebar stack">
      <SegmentedControl
        value={tab()}
        onChange={setTab}
        options={[
          { label: 'Backlinks', value: 'backlinks' },
          { label: 'Mentions', value: 'mentions' },
        ]}
      />
      <div class="right-sidebar-list stack divided-list scroll-y">
        <For each={tab() === 'backlinks' ? backlinks : unlinkedMentions}>
          {(item) => <BacklinkRow noteTitle={item.noteTitle} snippet={item.snippet} />}
        </For>
      </div>
    </aside>
  );
};

export default RightSidebar;
