import type { TabKind } from "../tabs/tabKinds";
import type { TabView } from "../tabs/tabModel";

export const TAG_TAB_KIND: TabKind = {
  kind: "tag",
  label: (tagPath) => `#${tagPath}`,
  evictable: true,
  persist: {
    toRecord: (tagPath) => ({ path: null, tag_path: tagPath }),
    fromRecord: (record) => record.tag_path,
  },
};

export function tagView(tagPath: string): TabView {
  return { kind: TAG_TAB_KIND.kind, key: tagPath };
}

export function tagPathOf(view: TabView): string | null {
  return view.kind === TAG_TAB_KIND.kind && "key" in view ? view.key : null;
}
